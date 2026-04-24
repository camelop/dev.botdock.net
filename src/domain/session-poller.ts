import { EventEmitter } from "node:events";
import { DataDir } from "../storage/index.ts";
import { readMachine } from "./machines.ts";
import {
  appendEvent,
  appendRaw,
  appendTranscript,
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
 *   SIZES <events_size> <raw_size> <tmux_alive> <tx_size>
 *   ---EVENTS-B64---
 *   <base64 of delta events.ndjson starting from EV_OFFSET>
 *   ---RAW-B64---
 *   <base64 of delta raw.log starting from RAW_OFFSET>
 *   ---TRANSCRIPT-B64---
 *   <base64 of delta claude-transcript.jsonl starting from TX_OFFSET>
 *   ---END---
 *
 * The transcript section is only populated when ccSessionFile is passed
 * (i.e. claude-code session whose jsonl we've already discovered).
 */
function pollScript(
  workdir: string,
  tmuxName: string,
  evOffset: number,
  rawOffset: number,
  /** Path of the agent's transcript on the remote — for claude-code this
   *  is the CC jsonl, for codex it's the rollout file. Polling treats it
   *  as opaque bytes; the kind only matters for self-discovery below. */
  transcriptFile: string | undefined,
  txOffset: number,
  /** Epoch seconds of session start; used to self-heal the transcript
   *  path if the shim's discovery helper missed it. */
  startedEpoch: number,
  agentKind: string,
): string {
  const txSrcQ = transcriptFile ? shQ(transcriptFile) : "''";
  // Self-heal command per agent. Generic-cmd has no transcript file, so
  // we skip scanning entirely. CC scans ~/.claude/projects; codex scans
  // $CODEX_HOME/sessions (default ~/.codex/sessions).
  let selfHeal = "";
  if (agentKind === "claude-code") {
    selfHeal = `
if [ -z "$TX_PATH" ] && [ -d "$HOME/.claude/projects" ]; then
  TX_PATH=$(find "$HOME/.claude/projects" -name '*.jsonl' -newermt "@${startedEpoch}" 2>/dev/null \\
            | head -1)
fi
`;
  } else if (agentKind === "codex") {
    selfHeal = `
if [ -z "$TX_PATH" ]; then
  CODEX_ROOT="\${CODEX_HOME:-$HOME/.codex}/sessions"
  if [ -d "$CODEX_ROOT" ]; then
    TX_PATH=$(find "$CODEX_ROOT" -type f -name 'rollout-*.jsonl' \\
              -newermt "@${startedEpoch}" 2>/dev/null | head -1)
  fi
fi
`;
  }
  return `
set -u
WORKDIR=${shQ(workdir)}
case "$WORKDIR" in
  "~")   WORKDIR="$HOME" ;;
  "~/"*) WORKDIR="$HOME$(printf '%s' "$WORKDIR" | cut -c2-)" ;;
esac
SDIR="$WORKDIR/.botdock/session"
EV_PATH="$SDIR/events.ndjson"
RAW_PATH="$SDIR/raw.log"
TX_PATH=${txSrcQ}
${selfHeal}
EV_SIZE=0; [ -f "$EV_PATH" ] && EV_SIZE=$(wc -c < "$EV_PATH" | tr -d ' ')
RAW_SIZE=0; [ -f "$RAW_PATH" ] && RAW_SIZE=$(wc -c < "$RAW_PATH" | tr -d ' ')
TX_SIZE=0; [ -n "$TX_PATH" ] && [ -f "$TX_PATH" ] && TX_SIZE=$(wc -c < "$TX_PATH" | tr -d ' ')
TMUX_ALIVE=0
if tmux has-session -t ${shQ(tmuxName)} >/dev/null 2>&1; then TMUX_ALIVE=1; fi
# Cap how much we transport per tick so spawnSync's 1 MiB stdout buffer
# doesn't ENOBUFS on a large backlog (resumed conversations can start
# with a multi-MB jsonl). The client re-polls on the next tick and the
# offsets walk forward.
CHUNK_MAX=${CHUNK_MAX_BYTES}
printf 'SIZES %s %s %s %s\\n' "$EV_SIZE" "$RAW_SIZE" "$TMUX_ALIVE" "$TX_SIZE"
printf 'TX_PATH=%s\\n' "$TX_PATH"
printf -- '---EVENTS-B64---\\n'
if [ "$EV_SIZE" -gt ${evOffset} ]; then
  tail -c +$((${evOffset}+1)) "$EV_PATH" | head -c "$CHUNK_MAX" | base64 | tr -d '\\n'
fi
printf '\\n---RAW-B64---\\n'
if [ "$RAW_SIZE" -gt ${rawOffset} ]; then
  tail -c +$((${rawOffset}+1)) "$RAW_PATH" | head -c "$CHUNK_MAX" | base64 | tr -d '\\n'
fi
printf '\\n---TRANSCRIPT-B64---\\n'
if [ -n "$TX_PATH" ] && [ "$TX_SIZE" -gt ${txOffset} ]; then
  tail -c +$((${txOffset}+1)) "$TX_PATH" | head -c "$CHUNK_MAX" | base64 | tr -d '\\n'
fi
printf '\\n---END---\\n'
`;
}

// Max bytes per stream per tick. 256 KiB of raw data → ~350 KiB base64,
// well under spawnSync's 1 MiB default even with three streams concatenated.
// Large backlogs drain over several ticks instead of a single ENOBUFS-y blast.
const CHUNK_MAX_BYTES = 256 * 1024;

function shQ(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

type Report = {
  eventsSize: number;
  rawSize: number;
  transcriptSize: number;
  tmuxAlive: boolean;
  eventsDelta: string;
  rawDelta: Buffer;
  transcriptDelta: string;
  /** Path the remote reported for the CC jsonl (empty string if none). The
   * poller's self-discovery may surface a path here even when we launched
   * without cc_session_file set. */
  txPath: string;
};

function parseReport(text: string): Report | null {
  // Accept either the 3-size (old) or 4-size (new, with transcript) format.
  const sizesMatch = /^SIZES (\d+) (\d+) (\d+)(?: (\d+))?/m.exec(text);
  if (!sizesMatch) return null;
  const eventsSize = Number(sizesMatch[1]);
  const rawSize = Number(sizesMatch[2]);
  const tmuxAlive = sizesMatch[3] === "1";
  const transcriptSize = sizesMatch[4] !== undefined ? Number(sizesMatch[4]) : 0;
  const txPathMatch = /^TX_PATH=(.*)$/m.exec(text);
  const txPath = (txPathMatch?.[1] ?? "").trim();
  const evStart = text.indexOf("---EVENTS-B64---\n");
  const rawStart = text.indexOf("\n---RAW-B64---\n");
  const txStart = text.indexOf("\n---TRANSCRIPT-B64---\n");
  const endStart = text.indexOf("\n---END---");
  if (evStart < 0 || rawStart < 0 || endStart < 0) return null;
  const evB64 = text.slice(evStart + "---EVENTS-B64---\n".length, rawStart);
  const rawB64 = txStart >= 0
    ? text.slice(rawStart + "\n---RAW-B64---\n".length, txStart)
    : text.slice(rawStart + "\n---RAW-B64---\n".length, endStart);
  const txB64 = txStart >= 0
    ? text.slice(txStart + "\n---TRANSCRIPT-B64---\n".length, endStart)
    : "";
  return {
    eventsSize,
    rawSize,
    transcriptSize,
    tmuxAlive,
    eventsDelta: evB64 ? Buffer.from(evB64, "base64").toString("utf8") : "",
    rawDelta: rawB64 ? Buffer.from(rawB64, "base64") : Buffer.alloc(0),
    transcriptDelta: txB64 ? Buffer.from(txB64, "base64").toString("utf8") : "",
    txPath,
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

  /** Resume loops for all active/provisioning sessions on startup. */
  resumeAll(): void {
    for (const s of listSessions(this.dir)) {
      if (s.status === "active" || s.status === "provisioning") this.watch(s.id);
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
      if (s.status !== "active") return;

      const report = this.pollOnce(s);
      if (report) this.apply(s, report);

      if (signal.aborted) return;
      await sleep(POLL_INTERVAL_MS, signal);
    }
  }

  private pollOnce(s: Session): Report | null {
    try {
      const machine = readMachine(this.dir, s.machine);
      const startedEpoch = Math.floor(
        (s.started_at ? Date.parse(s.started_at) : Date.parse(s.created_at)) / 1000,
      );
      // Pick the right transcript field for the agent. CC populates
      // `cc_session_file`, codex populates `codex_session_file`; both
      // are bytes-mirrored the same way once we know the path.
      const transcriptFile = s.agent_kind === "codex"
        ? s.codex_session_file
        : s.cc_session_file;
      const script = pollScript(
        s.workdir,
        s.tmux_session,
        s.remote_events_offset ?? 0,
        s.remote_raw_offset ?? 0,
        transcriptFile,
        s.remote_transcript_offset ?? 0,
        isFinite(startedEpoch) ? startedEpoch : 0,
        s.agent_kind,
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

    // Snapshot offsets before any updateSession() call. With the chunk cap
    // in pollScript(), the delta may be smaller than remote_size - offset
    // on a large backlog — the new offset must be prev + bytes, not full
    // remote_size (which would skip the unsent tail).
    const prevEvents = s.remote_events_offset ?? 0;
    const prevRaw = s.remote_raw_offset ?? 0;
    const prevTx = s.remote_transcript_offset ?? 0;

    // Poller may have discovered the agent's transcript path on its own
    // if the shim's one-shot find missed it. Commit the discovery to meta
    // so future ticks skip the find(). For CC we extract the UUID from
    // the basename minus .jsonl; for codex we pull the trailing 8-4-4-4-12
    // hex group out of the rollout filename.
    if (report.txPath) {
      if (s.agent_kind === "claude-code" && !s.cc_session_file) {
        const uuid = report.txPath.split("/").pop()?.replace(/\.jsonl$/, "");
        updateSession(this.dir, s.id, {
          cc_session_file: report.txPath,
          ...(uuid ? { cc_session_uuid: uuid } : {}),
        });
        appendEvent(this.dir, s.id, {
          ts: new Date().toISOString(),
          kind: "cc_session",
          file: report.txPath,
          uuid,
          source: "poller",
        });
        changed = true;
      } else if (s.agent_kind === "codex" && !s.codex_session_file) {
        const base = report.txPath.split("/").pop() ?? "";
        const uuid = base
          .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
          ?.[0];
        updateSession(this.dir, s.id, {
          codex_session_file: report.txPath,
          ...(uuid ? { codex_session_uuid: uuid } : {}),
        });
        appendEvent(this.dir, s.id, {
          ts: new Date().toISOString(),
          kind: "codex_session",
          file: report.txPath,
          uuid,
          source: "poller",
        });
        changed = true;
      }
    }

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
          if (ev.kind === "cc_session" && typeof ev.file === "string") {
            updateSession(this.dir, s.id, {
              cc_session_file: ev.file,
              ...(typeof ev.uuid === "string" ? { cc_session_uuid: ev.uuid } : {}),
            });
          }
          if (ev.kind === "codex_session" && typeof ev.file === "string") {
            updateSession(this.dir, s.id, {
              codex_session_file: ev.file,
              ...(typeof ev.uuid === "string" ? { codex_session_uuid: ev.uuid } : {}),
            });
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
      const evBytes = Buffer.byteLength(report.eventsDelta, "utf8");
      const patch: Partial<Session> = {
        remote_events_offset: Math.min(prevEvents + evBytes, report.eventsSize),
      };
      if (exitCodeFromEvent !== undefined) patch.exit_code = exitCodeFromEvent;
      updateSession(this.dir, s.id, patch);
    }

    if (report.rawDelta.length > 0) {
      appendRaw(this.dir, s.id, report.rawDelta);
      updateSession(this.dir, s.id, {
        remote_raw_offset: Math.min(prevRaw + report.rawDelta.length, report.rawSize),
        last_raw_at: new Date().toISOString(),
      });
      changed = true;
    }

    if (report.transcriptDelta.length > 0) {
      appendTranscript(this.dir, s.id, report.transcriptDelta);
      const txBytes = Buffer.byteLength(report.transcriptDelta, "utf8");
      updateSession(this.dir, s.id, {
        remote_transcript_offset: Math.min(prevTx + txBytes, report.transcriptSize),
        remote_transcript_size: report.transcriptSize,
        last_transcript_at: new Date().toISOString(),
      });
      changed = true;
    } else if (report.transcriptSize !== s.remote_transcript_size) {
      // No delta this tick but the remote reported a different total —
      // record it so the syncing-state check below sees fresh numbers.
      updateSession(this.dir, s.id, { remote_transcript_size: report.transcriptSize });
      changed = true;
    }

    // Derive activity from the local transcript mirror. CC and codex have
    // different log shapes — one parser per agent, but the same {running
    // | pending | syncing} output. Generic-cmd has no transcript, no
    // activity inference.
    const cur = readSession(this.dir, s.id);
    if (cur.status === "active" && cur.agent_kind === "claude-code") {
      const activity = computeActivity(cur, this.dir);
      if (activity !== cur.activity) {
        updateSession(this.dir, s.id, { activity });
        changed = true;
      }
    } else if (cur.status === "active" && cur.agent_kind === "codex") {
      const activity = computeCodexActivity(cur, this.dir);
      if (activity !== cur.activity) {
        updateSession(this.dir, s.id, { activity });
        changed = true;
      }
    }

    // tmux disappeared → session ended. Distinguish three cases:
    //  - shim wrote an `exited` event  → normal exit
    //  - shim wrote `failed_to_start`  → boot error, carry the reason
    //  - shim wrote neither            → crashed mid-boot; best hint we have
    //                                    is whatever landed in shim.stderr
    //                                    on the remote
    if (!report.tmuxAlive) {
      const cur = readSession(this.dir, s.id);
      if (cur.status === "active" || cur.status === "provisioning") {
        const delta = report.eventsDelta ?? "";
        const hasExit         = /"kind":\s*"exited"/.test(delta);
        const hasFailedToStart = /"kind":\s*"failed_to_start"/.test(delta);

        if (hasFailedToStart) {
          updateSession(this.dir, s.id, {
            status: "failed_to_start",
            exited_at: new Date().toISOString(),
          });
        } else {
          if (!hasExit) {
            appendEvent(this.dir, s.id, {
              ts: new Date().toISOString(),
              kind: "exited",
              exit_code: -1,
              note: "tmux session vanished without writing exit event (check .botdock/session/shim.stderr on the remote)",
            });
          }
          updateSession(this.dir, s.id, {
            status: "exited",
            exited_at: new Date().toISOString(),
          });
        }
        changed = true;
        this.unwatch(s.id);
      }
    }

    if (changed) this.emit("update", s.id);
  }
}

/**
 * Decide whether an active claude-code session is still doing something
 * ("running") or idle waiting for user input ("pending").
 *
 * Single source of truth: the last complete JSONL line in the local
 * transcript mirror.
 *   - Assistant message whose content is only `text` (no tool_use) ⇒
 *     turn finished ⇒ "pending".
 *   - Anything else (user just spoke, tool_use in flight, tool_result,
 *     unknown shape, empty transcript) ⇒ "running".
 *
 * No tmux/raw signal: the pane can be quiet for lots of reasons (API
 * latency, compaction pauses) that don't mean the agent is idle.
 */
function computeActivity(
  s: Session,
  dir: import("../storage/index.ts").DataDir,
): "running" | "pending" | "syncing" {
  // Backlog draining: our local mirror is behind the remote. The last-line
  // heuristic would read stale data in this window, so surface "syncing"
  // explicitly. Tolerate a 1-byte slack to avoid flapping on the final
  // partial chunk during steady-state writes.
  const off = s.remote_transcript_offset ?? 0;
  const size = s.remote_transcript_size ?? 0;
  if (size > 0 && off + 1 < size) return "syncing";
  const lastEntry = readLastTranscriptEntry(dir, s.id);
  if (!lastEntry) return "running";
  return lastEntryLooksFinal(lastEntry) ? "pending" : "running";
}

/**
 * Codex activity heuristic. Drives off the rollout's lifecycle EventMsg
 * entries — `task_started` / `turn_started` / `*_delta` / `task_complete`
 * / `turn_complete` / `turn_aborted` / `error`. We scan back through the
 * tail of the rollout for the most recent EventMsg and decide:
 *   - turn_complete / task_complete / turn_aborted / error → pending
 *   - anything else (turn_started, *_delta, etc.)           → running
 *   - no EventMsg lines at all so far                       → running
 *
 * Codex's wire format tags the variants under `type: "event_msg"` with a
 * `msg` discriminator (see codex-rs/protocol/src/protocol.rs's EventMsg
 * enum). We tolerate both `event_msg` and a future `event` shape and
 * read whichever string field looks like the discriminator.
 */
function computeCodexActivity(
  s: Session,
  dir: import("../storage/index.ts").DataDir,
): "running" | "pending" | "syncing" {
  const off = s.remote_transcript_offset ?? 0;
  const size = s.remote_transcript_size ?? 0;
  if (size > 0 && off + 1 < size) return "syncing";
  const ev = readLastCodexEvent(dir, s.id);
  if (!ev) return "running";
  // The kind discriminator can land under .msg (variant tag) or .type
  // (envelope tag). Try both — codex's serde renames over time and the
  // exact JSON shape isn't stable across versions.
  const msg = String((ev as { msg?: unknown }).msg ?? "");
  const finalMsgs = new Set([
    "task_complete", "turn_complete",
    "task_aborted", "turn_aborted",
    "error",
  ]);
  if (finalMsgs.has(msg)) return "pending";
  return "running";
}

/** Read the last `event_msg` line from the codex rollout mirror. Returns
 *  null when the file is empty or no EventMsg has been seen yet. Same
 *  read-tail-of-file approach as readLastTranscriptEntry but filters to
 *  EventMsg-shaped entries only. */
function readLastCodexEvent(
  dir: import("../storage/index.ts").DataDir,
  id: string,
): Record<string, unknown> | null {
  try {
    const { statSync, openSync, readSync, closeSync } = require("node:fs") as typeof import("node:fs");
    const path = dir.path("sessions", id, "transcript.ndjson");
    const size = statSync(path).size;
    if (size === 0) return null;
    const len = Math.min(size, 64 * 1024);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n").filter((l) => l.length > 0);
      // Walk backwards looking for an EventMsg-shaped line. Other shapes
      // (response_item, session_meta, compacted, turn_context) tell us
      // nothing about turn-completion state, so they're skipped.
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
          const type = String(obj.type ?? "");
          if (type === "event_msg" || obj.msg !== undefined) return obj;
        } catch { /* malformed line, skip */ }
      }
      return null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readLastTranscriptEntry(
  dir: import("../storage/index.ts").DataDir,
  id: string,
): Record<string, unknown> | null {
  try {
    const { statSync, openSync, readSync, closeSync } = require("node:fs") as typeof import("node:fs");
    const path = dir.path("sessions", id, "transcript.ndjson");
    const size = statSync(path).size;
    if (size === 0) return null;
    // Read the last 32KB and take the last non-empty line.
    const len = Math.min(size, 32 * 1024);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const text = buf.toString("utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return null;
      return JSON.parse(lastLine) as Record<string, unknown>;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function lastEntryLooksFinal(entry: Record<string, unknown>): boolean {
  // CC emits a grab-bag of idle-state metadata entries after the agent
  // finishes a turn. Treat any of them as "not running":
  //   system/turn_duration   — lands right after the last assistant msg
  //   system/away_summary    — written while idle (summarizing state)
  //   last-prompt            — records the next-user-prompt scaffold
  //   permission-mode        — records the tool-permission mode (idle setting)
  // Newer CC versions add variants; keeping the allowlist explicit is safer
  // than a default-final policy that could mis-flag real in-flight output.
  const topType = entry.type as string | undefined;
  const subtype = (entry as any).subtype as string | undefined;
  if (topType === "last-prompt" || topType === "permission-mode") {
    return true;
  }
  if (topType === "system" && (subtype === "turn_duration" || subtype === "away_summary")) {
    return true;
  }

  // Otherwise: finished assistant message = role === "assistant" with only
  // text blocks (no in-flight tool_use).
  const msg = (entry as any).message;
  if (!msg || typeof msg !== "object") return false;
  if (msg.role !== "assistant") return false;
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  return content.every((c: any) => c && c.type === "text");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
