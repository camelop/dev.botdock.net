import { EventEmitter } from "node:events";
import { DataDir } from "../storage/index.ts";
import { readMachine } from "./machines.ts";
import {
  appendEvent,
  appendRaw,
  listSessions,
  readSession,
  updateSession,
  type Session,
  type SessionEvent,
} from "./sessions.ts";
import { sshExec } from "../lib/remote.ts";

const POLL_INTERVAL_MS = 2500;

/**
 * Single script invoked over ssh per poll. Returns a parseable report:
 *
 *   SIZES <events_size> <raw_size> <tmux_alive>
 *   ---EVENTS-B64---
 *   <base64 of delta events.ndjson starting from EV_OFFSET>
 *   ---RAW-B64---
 *   <base64 of delta raw.log starting from RAW_OFFSET>
 *   ---END---
 */
function pollScript(workdir: string, tmuxName: string, evOffset: number, rawOffset: number): string {
  // Inputs are validated earlier (name charset, workdir absolute path). Still,
  // wrap values in quotes to avoid word-splitting surprises.
  return `
set -u
SDIR=${shQ(workdir)}/.botdock/session
EV_PATH="$SDIR/events.ndjson"
RAW_PATH="$SDIR/raw.log"
EV_SIZE=0; [ -f "$EV_PATH" ] && EV_SIZE=$(wc -c < "$EV_PATH" | tr -d ' ')
RAW_SIZE=0; [ -f "$RAW_PATH" ] && RAW_SIZE=$(wc -c < "$RAW_PATH" | tr -d ' ')
TMUX_ALIVE=0
if tmux has-session -t ${shQ(tmuxName)} >/dev/null 2>&1; then TMUX_ALIVE=1; fi
printf 'SIZES %s %s %s\\n' "$EV_SIZE" "$RAW_SIZE" "$TMUX_ALIVE"
printf -- '---EVENTS-B64---\\n'
if [ "$EV_SIZE" -gt ${evOffset} ]; then
  tail -c +$((${evOffset}+1)) "$EV_PATH" | base64 | tr -d '\\n'
fi
printf '\\n---RAW-B64---\\n'
if [ "$RAW_SIZE" -gt ${rawOffset} ]; then
  tail -c +$((${rawOffset}+1)) "$RAW_PATH" | base64 | tr -d '\\n'
fi
printf '\\n---END---\\n'
`;
}

function shQ(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

type Report = {
  eventsSize: number;
  rawSize: number;
  tmuxAlive: boolean;
  eventsDelta: string;
  rawDelta: Buffer;
};

function parseReport(text: string): Report | null {
  const sizesMatch = /^SIZES (\d+) (\d+) (\d+)/m.exec(text);
  if (!sizesMatch) return null;
  const eventsSize = Number(sizesMatch[1]);
  const rawSize = Number(sizesMatch[2]);
  const tmuxAlive = sizesMatch[3] === "1";
  const evStart = text.indexOf("---EVENTS-B64---\n");
  const rawStart = text.indexOf("\n---RAW-B64---\n");
  const endStart = text.indexOf("\n---END---");
  if (evStart < 0 || rawStart < 0 || endStart < 0) return null;
  const evB64 = text.slice(evStart + "---EVENTS-B64---\n".length, rawStart);
  const rawB64 = text.slice(rawStart + "\n---RAW-B64---\n".length, endStart);
  return {
    eventsSize,
    rawSize,
    tmuxAlive,
    eventsDelta: evB64 ? Buffer.from(evB64, "base64").toString("utf8") : "",
    rawDelta: rawB64 ? Buffer.from(rawB64, "base64") : Buffer.alloc(0),
  };
}

/**
 * Manages polling loops for running sessions. One loop per session.
 * Emits `update` whenever any session gained new events or raw output so that
 * connected WebSocket clients can push deltas.
 */
export class SessionPoller extends EventEmitter {
  private loops = new Map<string, AbortController>();

  constructor(private readonly dir: DataDir) {
    super();
  }

  /** Resume loops for all sessions in running/provisioning state on startup. */
  resumeAll(): void {
    for (const s of listSessions(this.dir)) {
      if (s.status === "running" || s.status === "provisioning") this.watch(s.id);
    }
  }

  watch(id: string): void {
    if (this.loops.has(id)) return;
    const ctl = new AbortController();
    this.loops.set(id, ctl);
    this.loop(id, ctl.signal).catch((err) => {
      console.error(`[poller ${id}] fatal:`, err);
      appendEvent(this.dir, id, {
        ts: new Date().toISOString(),
        kind: "error",
        message: String((err as Error)?.message ?? err),
      });
    }).finally(() => this.loops.delete(id));
  }

  unwatch(id: string): void {
    this.loops.get(id)?.abort();
    this.loops.delete(id);
  }

  stopAll(): void {
    for (const ctl of this.loops.values()) ctl.abort();
    this.loops.clear();
  }

  private async loop(id: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const s = readSession(this.dir, id);
      if (s.status !== "running") return;

      const report = this.pollOnce(s);
      if (report) this.apply(s, report);

      if (signal.aborted) return;
      await sleep(POLL_INTERVAL_MS, signal);
    }
  }

  private pollOnce(s: Session): Report | null {
    try {
      const machine = readMachine(this.dir, s.machine);
      const script = pollScript(
        s.workdir,
        s.tmux_session,
        s.remote_events_offset ?? 0,
        s.remote_raw_offset ?? 0,
      );
      const r = sshExec(this.dir, machine, "bash -s", script, 15_000);
      if (r.code !== 0) {
        console.error(`[poller ${s.id}] ssh exit ${r.code}: ${r.stderr.slice(0, 200)}`);
        return null;
      }
      return parseReport(r.stdout);
    } catch (e) {
      console.error(`[poller ${s.id}]`, e);
      return null;
    }
  }

  private apply(s: Session, report: Report): void {
    let changed = false;

    let exitCodeFromEvent: number | undefined;
    if (report.eventsDelta) {
      for (const line of report.eventsDelta.split("\n")) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as SessionEvent;
          appendEvent(this.dir, s.id, { ...ev, source: "remote" });
          changed = true;
          if (ev.kind === "exited" && typeof ev.exit_code === "number") {
            exitCodeFromEvent = ev.exit_code;
          }
        } catch {
          // Malformed line — preserve verbatim for debugging.
          appendEvent(this.dir, s.id, {
            ts: new Date().toISOString(),
            kind: "error",
            message: "malformed remote event",
            raw: line,
          });
        }
      }
      const patch: Partial<Session> = { remote_events_offset: report.eventsSize };
      if (exitCodeFromEvent !== undefined) patch.exit_code = exitCodeFromEvent;
      updateSession(this.dir, s.id, patch);
    }

    if (report.rawDelta.length > 0) {
      appendRaw(this.dir, s.id, report.rawDelta);
      updateSession(this.dir, s.id, { remote_raw_offset: report.rawSize });
      changed = true;
    }

    // tmux disappeared → session ended. If no "exited" event was ever written,
    // synthesize one so the UI has a timeline entry.
    if (!report.tmuxAlive) {
      const cur = readSession(this.dir, s.id);
      if (cur.status === "running") {
        const hasExit = /"kind":\s*"exited"/.test(report.eventsDelta ?? "");
        if (!hasExit) {
          appendEvent(this.dir, s.id, {
            ts: new Date().toISOString(),
            kind: "exited",
            exit_code: -1,
            note: "tmux session vanished without writing exit event",
          });
        }
        updateSession(this.dir, s.id, { status: "exited", exited_at: new Date().toISOString() });
        changed = true;
        this.unwatch(s.id);
      }
    }

    if (changed) this.emit("update", s.id);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
