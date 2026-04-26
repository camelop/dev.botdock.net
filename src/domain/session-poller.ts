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
  // Validate the existing TX_PATH every tick — if the file's first
  // ~20 lines don't include a cwd field matching this session's workdir
  // we know a previous build's race-prone discovery (or another
  // session's shim) planted the wrong file in meta. Scan 20 lines, not
  // just 1: CC's first jsonl line is often a session-init / system /
  // summary record without a top-level cwd; the field shows up on the
  // user/assistant message rows that come right after. Codex's
  // session_meta is line 1 so this is no harder for it.
  // Emit TX_PATH_INVALIDATED so the daemon-side apply() can clear meta
  // + offsets + truncate the local mirror; THIS tick we skip both the
  // transcript-read and the self-heal so we don't ingest one more
  // chunk of cross-talk before the reset takes effect.
  const validateStanza = `
TX_INVALIDATED=0
if [ -n "$TX_PATH" ] && [ -f "$TX_PATH" ]; then
  # Recovery for the v0.7.11 self-heal bug: any TX_PATH that lives under
  # a CC project's subagents/ subdir is a sub-conversation jsonl, never
  # the main transcript. Older self-heal accepted them because their cwd
  # matches the project; clear so the new self-heal (which excludes
  # subagents/) re-discovers the top-level file.
  case "$TX_PATH" in
    */subagents/*)
      printf 'TX_PATH_INVALIDATED=%s\\n' "$TX_PATH"
      TX_PATH=""
      TX_INVALIDATED=1
      ;;
  esac
fi
if [ -n "$TX_PATH" ] && [ -f "$TX_PATH" ]; then
  HEAD20=$(head -n 20 "$TX_PATH" 2>/dev/null)
  # Be conservative on cwd — only invalidate when we have *positive*
  # evidence the cwd is wrong. Older builds invalidated on "cwd not
  # matching", which also fires when the file's first 20 lines have no
  # cwd field at all (CC's first lines are often permission-mode /
  # file-history-snapshot rows with no cwd) — that nuked every CC
  # session's local transcript on first poll after the v0.7.11 upgrade.
  if printf '%s' "$HEAD20" | grep -q -F '"cwd":' \\
     && ! printf '%s' "$HEAD20" | grep -q -F "\\"cwd\\":\\"$WORKDIR\\""; then
    printf 'TX_PATH_INVALIDATED=%s\\n' "$TX_PATH"
    TX_PATH=""
    TX_INVALIDATED=1
  fi
fi
if [ -n "$TX_PATH" ] && [ -f "$TX_PATH" ]; then
  # Spawned-subagent / agent-teams-team-member jsonls always begin with
  # the orchestrator-injected envelope:
  #   {"type":"user","message":{"role":"user","content":"<system>\\nYou are ...
  # A real user-driven main session never has that exact substring. If
  # we landed on one of these spawn jsonls, clear it so self-heal can
  # pick the orchestrator's main jsonl instead.
  if head -n 20 "$TX_PATH" 2>/dev/null \\
     | grep -q -F '"role":"user","content":"<system>'; then
    printf 'TX_PATH_INVALIDATED=%s\\n' "$TX_PATH"
    TX_PATH=""
    TX_INVALIDATED=1
  fi
fi
`;
  let selfHeal = "";
  // Both agents' self-heal probes have to match the rollout's first-line
  // cwd against $WORKDIR — otherwise two concurrent sessions on the same
  // machine both see each other's just-created jsonls (mtime-newer-than-
  // either-session's-epoch matches BOTH files) and pick the wrong one,
  // cross-wiring their transcripts. Bug surfaced by user 2026-04-25.
  if (agentKind === "claude-code") {
    // CC project-dir layout has three failure modes for naive self-heal:
    //   1. ~/.claude/projects/<dir>/<uuid>/subagents/agent-<hex>.jsonl
    //      Task-tool sub-conversations. Excluded via -not -path.
    //   2. Multiple top-level <uuid>.jsonl files in the same project
    //      dir, all with matching cwd: every Task spawn that opens a
    //      "named agent" prompt creates a new top-level jsonl, and
    //      --experimental-agent-teams gives every team member its own
    //      top-level jsonl too. The first user message of every one of
    //      these spawn jsonls is the orchestrator's
    //      `"<system>\\nYou are <agent>..."` envelope; the orchestrator's
    //      OWN jsonl has the user's actual typed prompt as its first
    //      user message. Skip candidates whose head matches the spawn
    //      signature.
    //   3. Among the remaining real-user-driven candidates, pick the
    //      one with the latest mtime — that's the file CC is currently
    //      writing to.
    selfHeal = `
if [ -z "$TX_PATH" ] && [ "$TX_INVALIDATED" = "0" ] && [ -d "$HOME/.claude/projects" ]; then
  BEST_PATH=""
  BEST_MTIME=0
  while IFS= read -r cand; do
    [ -f "$cand" ] || continue
    HEAD20=$(head -n 20 "$cand" 2>/dev/null)
    printf '%s' "$HEAD20" | grep -q -F "\\"cwd\\":\\"$WORKDIR\\"" || continue
    printf '%s' "$HEAD20" | grep -q -F '"role":"user","content":"<system>' \\
      && continue
    M=$(stat -c '%Y' "$cand" 2>/dev/null) || continue
    [ "$M" -gt "$BEST_MTIME" ] || continue
    BEST_PATH="$cand"
    BEST_MTIME="$M"
  done <<TX_FIND_EOF
$(find "$HOME/.claude/projects" -name '*.jsonl' -not -path '*/subagents/*' -newermt "@${startedEpoch}" 2>/dev/null)
TX_FIND_EOF
  TX_PATH="$BEST_PATH"
fi
`;
  } else if (agentKind === "codex") {
    // Same shape as CC's self-heal but for codex's rollout layout. Pick
    // the latest-mtime rollout whose first-line session_meta carries the
    // matching cwd — that's the file codex is actively writing. Without
    // mtime-latest, prior rollouts in the same workdir all match cwd
    // and the first hit (essentially random find order) wins.
    selfHeal = `
if [ -z "$TX_PATH" ] && [ "$TX_INVALIDATED" = "0" ]; then
  CODEX_ROOT="\${CODEX_HOME:-$HOME/.codex}/sessions"
  if [ -d "$CODEX_ROOT" ]; then
    BEST_PATH=""
    BEST_MTIME=0
    while IFS= read -r cand; do
      [ -f "$cand" ] || continue
      head -n 20 "$cand" 2>/dev/null | grep -q -F "\\"cwd\\":\\"$WORKDIR\\"" || continue
      M=$(stat -c '%Y' "$cand" 2>/dev/null) || continue
      [ "$M" -gt "$BEST_MTIME" ] || continue
      BEST_PATH="$cand"
      BEST_MTIME="$M"
    done <<TX_FIND_EOF
$(find "$CODEX_ROOT" -type f -name 'rollout-*.jsonl' -newermt "@${startedEpoch}" 2>/dev/null)
TX_FIND_EOF
    TX_PATH="$BEST_PATH"
  fi
fi
`;
  } else {
    // generic-cmd: no transcript file at all, so the validate stanza
    // above already cleared TX_PATH if anything weird was set, and we
    // skip self-heal entirely. The TX_INVALIDATED guard isn't needed
    // here but the variable still has to be set for the reader below.
    selfHeal = "";
  }
  selfHeal = validateStanza + selfHeal;
  return `
set -u
WORKDIR=${shQ(workdir)}
case "$WORKDIR" in
  "~")   WORKDIR="$HOME" ;;
  "~/"*) WORKDIR="$HOME$(printf '%s' "$WORKDIR" | cut -c2-)" ;;
esac
# Strip a trailing slash so the cwd grep below matches the JSONL value
# exactly. CC and codex both write \`pwd\` of their process, which never
# carries a trailing slash for non-root paths. Without this strip,
# user-supplied workdirs like "~/foo/" never matched against
# "cwd":"/home/.../foo" and the transcript discovery never adopted any
# candidate — symptom was the UI hanging on "Waiting for ... JSONL".
case "$WORKDIR" in
  /) ;;
  */) WORKDIR="\${WORKDIR%/}" ;;
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
  /** When the script detected a stale TX_PATH whose first-line cwd doesn't
   *  match this session's workdir, it emits TX_PATH_INVALIDATED with the
   *  old wrong path. The daemon must clear meta + truncate the local
   *  transcript mirror + reset offsets so the next tick's self-heal can
   *  start fresh from the right file. Recovery path for the v0.7.x
   *  transcript-cross-talk bug; the validation runs every tick so it
   *  also self-corrects future regressions. */
  txPathInvalidated?: string;
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
  const invalidatedMatch = /^TX_PATH_INVALIDATED=(.*)$/m.exec(text);
  const txPathInvalidated = invalidatedMatch ? (invalidatedMatch[1] ?? "").trim() : undefined;
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
    txPathInvalidated,
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

    // Stale-transcript recovery. The bash script flagged that the
    // currently-pinned TX_PATH belongs to a DIFFERENT session (its
    // first-line cwd doesn't match this session's workdir). Wipe the
    // local mirror, drop meta, reset offsets — next tick will self-
    // heal cleanly. Audit-log the event so the user knows why their
    // session's transcript page count just dropped to zero.
    if (report.txPathInvalidated) {
      this.invalidateStaleTranscript(s, report.txPathInvalidated);
      // Re-read the session: the meta we just wrote is what subsequent
      // logic compares against (the in-memory `s` is stale). Continue
      // applying events / raw deltas this tick — they're not affected
      // by the wrong TX_PATH.
      s = readSession(this.dir, s.id);
      changed = true;
    }

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

  /**
   * Recovery for the v0.7.x transcript-cross-talk bug: clear meta's
   * agent-session pointer + transcript offsets, truncate the local
   * mirror so subsequent pollScript ticks start clean from the right
   * file. Always logs an info event so the audit trail explains the
   * sudden page-count drop in the UI.
   */
  private invalidateStaleTranscript(s: Session, wrongPath: string): void {
    const fs = require("node:fs") as typeof import("node:fs");
    try {
      const local = this.dir.path("sessions", s.id, "transcript.ndjson");
      try { fs.truncateSync(local, 0); } catch (e) {
        // ENOENT is fine — the next append will create the file.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    } catch (e) {
      console.error(`[poller ${s.id}] could not truncate stale transcript:`, e);
    }
    const patch: Partial<Session> = {
      remote_transcript_offset: 0,
      remote_transcript_size: 0,
    };
    if (s.agent_kind === "claude-code") {
      patch.cc_session_file = undefined;
      patch.cc_session_uuid = undefined;
    } else if (s.agent_kind === "codex") {
      patch.codex_session_file = undefined;
      patch.codex_session_uuid = undefined;
    }
    updateSession(this.dir, s.id, patch);
    appendEvent(this.dir, s.id, {
      ts: new Date().toISOString(),
      kind: "info",
      subject: "transcript-invalidated",
      previous_path: wrongPath,
      reason: "first-line cwd did not match this session's workdir; another session's transcript was being mirrored here",
    });
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
 * Codex activity heuristic. Codex rollout JSONL wraps each row as
 *   { timestamp, type: "<envelope>", payload: { type: "<subtype>", ... } }
 * with envelope ∈ { session_meta, event_msg, response_item, turn_context }
 * and the subtype-of-event under payload.type. Only event_msg rows tell
 * us about turn lifecycle; we walk back to the most recent event_msg and
 * decide by its payload.type:
 *   task_complete / turn_complete / task_aborted / turn_aborted / error
 *     → pending (turn finished, awaiting user)
 *   anything else (task_started, agent_message_delta, token_count, …)
 *     → running
 *   no event_msg at all yet → running
 *
 * `syncing` still applies when we're behind on byte-mirroring — same
 * flapping-prevention as the CC heuristic.
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
  const payload = (ev.payload as Record<string, unknown> | undefined) ?? {};
  const subType = String(payload.type ?? "");
  const finalSubtypes = new Set([
    "task_complete", "turn_complete",
    "task_aborted", "turn_aborted",
    "error",
  ]);
  if (finalSubtypes.has(subType)) return "pending";
  return "running";
}

/** Read the last `event_msg`-envelope line from the codex rollout mirror.
 *  Returns null when the file is empty or no event_msg has been seen yet.
 *  Walks the tail backwards so other envelopes (session_meta /
 *  response_item / turn_context) get skipped — they tell us nothing
 *  about turn-completion state. */
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
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
          if (obj.type === "event_msg") return obj;
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
