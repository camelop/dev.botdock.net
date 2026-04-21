import { existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DataDir, assertSafeName, readToml, writeToml, appendNdjson, readNdjson } from "../storage/index.ts";
import type { NdjsonReadResult } from "../storage/index.ts";

export type SessionStatus =
  | "provisioning"
  | "active"
  | "exited"
  | "failed_to_start";

export type AgentKind = "generic-cmd" | "claude-code";

export type Session = {
  id: string;
  machine: string;         // machines/<name>
  workdir: string;         // absolute path on the remote
  agent_kind: AgentKind;
  cmd: string;             // shell command line for generic-cmd; stub for claude-code
  tmux_session: string;    // e.g. "botdock-<id>"
  status: SessionStatus;
  created_at: string;
  started_at?: string;
  exited_at?: string;
  exit_code?: number;
  /** tail offsets for the remote files we mirror */
  remote_events_offset?: number;
  remote_raw_offset?: number;
  /** For claude-code: absolute path on remote to the claude transcript JSONL. */
  cc_session_file?: string;
  /** For claude-code: the session UUID (basename of the transcript file). */
  cc_session_uuid?: string;
  /** For claude-code: local port that the BotDock daemon proxies to this
   * session's dedicated ttyd. Populated after the terminal is spawned. */
  terminal_local_port?: number;
  /** For claude-code: the remote port ttyd is listening on (useful for
   * debugging; not used by the proxy directly). */
  terminal_remote_port?: number;
  /** Byte offset into the remote CC jsonl we've already mirrored locally. */
  remote_transcript_offset?: number;
  /** Wallclock timestamps of the last time the poller saw growth in each
   * stream. Used by the activity-state heuristic. */
  last_raw_at?: string;
  last_transcript_at?: string;
  /** Derived activity (only meaningful for active claude-code sessions):
   *   "running" = agent is producing output / using a tool,
   *   "pending" = agent has completed its turn, awaiting the user. */
  activity?: "running" | "pending";
  /** For claude-code: if true, the shim launches claude with
   *  --dangerously-skip-permissions so the folder-trust dialog and
   *  per-tool permission prompts are auto-accepted. Opt-in per session. */
  cc_skip_trust?: boolean;
  /** For claude-code: if set, the shim runs `claude --resume <uuid>` to
   * continue a prior conversation on the remote instead of starting a
   * fresh one. The workdir must match the resumed session's cwd. */
  cc_resume_uuid?: string;
  /** User-chosen display name for the session. Persisted in meta.toml so
   * it survives across browsers / reloads. */
  alias?: string;
  /** User-chosen accent color name for the session's sidebar row / avatar
   * frame. One of the keys in ALIAS_COLORS (see lib/alias-colors.ts). */
  alias_color?: string;
};

export type SessionEvent = {
  ts: string;
  kind:
    | "created"
    | "provisioning"
    | "started"
    | "heartbeat"
    | "exited"
    | "failed_to_start"
    | "stopping"
    | "stopped"
    | "user_task"    // user sent a task through file-drop channel
    | "user_input"   // user sent a task via tmux send-keys channel
    | "cc_session"   // claude-code transcript jsonl discovered
    | "shim_boot"    // the shim script reached its first line
    | "pre_claude"   // about to exec claude (carries resolved binary path)
    | "error";
  [k: string]: unknown;
};

function sessionDir(dir: DataDir, id: string): string {
  assertSafeName(id, "session id");
  return join(dir.sessionsDir(), id);
}

function paths(dir: DataDir, id: string) {
  const base = sessionDir(dir, id);
  return {
    base,
    meta: join(base, "meta.toml"),
    events: join(base, "events.ndjson"),
    transcript: join(base, "transcript.ndjson"),
    pushes: join(base, "pushes.ndjson"),
    raw: join(base, "raw.log"),
  };
}

export function newSessionId(): string {
  // 8 hex chars, collision-resistant enough for local use and tmux-session-friendly.
  return randomBytes(4).toString("hex");
}

export function createSessionRecord(
  dir: DataDir,
  args: {
    machine: string;
    workdir: string;
    agent_kind: AgentKind;
    cmd: string;
    cc_skip_trust?: boolean;
    cc_resume_uuid?: string;
  },
): Session {
  const id = newSessionId();
  const s: Session = {
    id,
    machine: args.machine,
    workdir: args.workdir,
    agent_kind: args.agent_kind,
    cmd: args.cmd,
    tmux_session: `botdock-${id}`,
    status: "provisioning",
    created_at: new Date().toISOString(),
    remote_events_offset: 0,
    remote_raw_offset: 0,
    ...(args.cc_skip_trust ? { cc_skip_trust: true } : {}),
    ...(args.cc_resume_uuid ? { cc_resume_uuid: args.cc_resume_uuid } : {}),
  };
  const p = paths(dir, id);
  mkdirSync(p.base, { recursive: true });
  writeSession(dir, s);
  appendEvent(dir, id, { ts: s.created_at, kind: "created", machine: args.machine, workdir: args.workdir });
  return s;
}

export function writeSession(dir: DataDir, s: Session): void {
  const p = paths(dir, s.id);
  writeToml(p.meta, s as unknown as Record<string, unknown>);
}

export function readSession(dir: DataDir, id: string): Session {
  const p = paths(dir, id);
  if (!existsSync(p.meta)) throw new Error(`session not found: ${id}`);
  return normalizeSession(readToml<Session>(p.meta));
}

/**
 * Backward-compat: pre-v0.1.4 meta.toml still has status="running" and
 * activity="waiting". Rewrite on read so the rest of the app never has
 * to double-check. New writes use "active" / "pending".
 */
function normalizeSession(s: Session): Session {
  const out = { ...s };
  if ((out.status as unknown as string) === "running") out.status = "active";
  if ((out.activity as unknown as string) === "waiting") out.activity = "pending";
  return out;
}

export function sessionExists(dir: DataDir, id: string): boolean {
  try { return existsSync(paths(dir, id).meta); } catch { return false; }
}

export function listSessions(dir: DataDir): Session[] {
  const root = dir.sessionsDir();
  if (!existsSync(root)) return [];
  const out: Session[] = [];
  for (const id of readdirSync(root)) {
    try { assertSafeName(id, "session id"); } catch { continue; }
    const metaPath = join(root, id, "meta.toml");
    if (existsSync(metaPath)) out.push(normalizeSession(readToml<Session>(metaPath)));
  }
  // newest first
  out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return out;
}

export function updateSession(dir: DataDir, id: string, patch: Partial<Session>): Session {
  const s = readSession(dir, id);
  const next = { ...s, ...patch };
  writeSession(dir, next);
  return next;
}

export function appendEvent(dir: DataDir, id: string, event: SessionEvent): void {
  const p = paths(dir, id);
  appendNdjson(p.events, event);
}

export function readEvents(dir: DataDir, id: string, fromOffset = 0): NdjsonReadResult<SessionEvent> {
  return readNdjson<SessionEvent>(paths(dir, id).events, fromOffset);
}

/**
 * Append already-newline-terminated transcript lines (raw JSONL from the
 * CC jsonl) to the local mirror. Caller must ensure each entry ends with \n.
 */
export function appendTranscript(dir: DataDir, id: string, chunk: string | Buffer): void {
  const p = paths(dir, id);
  mkdirSync(p.base, { recursive: true });
  const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  const { appendFileSync } = require("node:fs") as typeof import("node:fs");
  appendFileSync(p.transcript, buf);
}

/**
 * Read the last N non-empty lines of the local transcript mirror. Returns
 * them as parsed JSON objects, dropping any that fail to parse. Used by
 * the war-room view to summarize each session without pulling the full
 * transcript over the wire each tick.
 */
export function readRecentTranscriptLines(
  dir: DataDir,
  id: string,
  lines: number,
): Record<string, unknown>[] {
  const p = paths(dir, id).transcript;
  let size = 0;
  try { size = statSync(p).size; } catch { return []; }
  if (size === 0) return [];

  // Heuristic: most CC jsonl lines fit inside ~2KB each. Start by reading
  // the tail and if we don't have enough lines, expand.
  let readBytes = Math.min(size, Math.max(16 * 1024, lines * 2048));
  const { openSync, readSync, closeSync } = require("node:fs") as typeof import("node:fs");
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(readBytes);
    readSync(fd, buf, 0, readBytes, size - readBytes);
    const text = buf.toString("utf8");
    const all = text.split("\n").filter((s) => s.length > 0);
    // If the first line was mid-chunk, drop it.
    const candidates = size === readBytes ? all : all.slice(1);
    const tail = candidates.slice(-lines);
    const parsed: Record<string, unknown>[] = [];
    for (const line of tail) {
      try { parsed.push(JSON.parse(line) as Record<string, unknown>); } catch { /* drop */ }
    }
    return parsed;
  } finally {
    closeSync(fd);
  }
}

export function readTranscriptRange(
  dir: DataDir,
  id: string,
  fromOffset = 0,
  max = 256 * 1024,
): { data: string; nextOffset: number; size: number } {
  const p = paths(dir, id).transcript;
  let size = 0;
  try { size = statSync(p).size; } catch { return { data: "", nextOffset: fromOffset, size: 0 }; }
  if (fromOffset >= size) return { data: "", nextOffset: size, size };
  const length = Math.min(size - fromOffset, max);
  const { openSync, readSync, closeSync } = require("node:fs") as typeof import("node:fs");
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromOffset);
    return { data: buf.toString("utf8"), nextOffset: fromOffset + length, size };
  } finally {
    closeSync(fd);
  }
}

/** Append raw bytes captured from the remote pane. */
export function appendRaw(dir: DataDir, id: string, chunk: string | Buffer): void {
  const p = paths(dir, id);
  mkdirSync(p.base, { recursive: true });
  const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  // Use node:fs appendFileSync via our ndjson helper's parent dir mk; but ndjson adds \n.
  // Import directly to avoid forcing newline.
  const { appendFileSync } = require("node:fs") as typeof import("node:fs");
  appendFileSync(p.raw, buf);
}

export function readRawRange(
  dir: DataDir,
  id: string,
  fromOffset = 0,
  max = 64 * 1024,
): { data: string; nextOffset: number; size: number } {
  const p = paths(dir, id).raw;
  let size = 0;
  try { size = statSync(p).size; } catch { return { data: "", nextOffset: fromOffset, size: 0 }; }
  if (fromOffset >= size) return { data: "", nextOffset: size, size };
  const length = Math.min(size - fromOffset, max);
  const { openSync, readSync, closeSync } = require("node:fs") as typeof import("node:fs");
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromOffset);
    return { data: buf.toString("utf8"), nextOffset: fromOffset + length, size };
  } finally {
    closeSync(fd);
  }
}

export function deleteSession(dir: DataDir, id: string): void {
  const p = paths(dir, id);
  if (!existsSync(p.base)) throw new Error(`session not found: ${id}`);
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  rmSync(p.base, { recursive: true, force: true });
}
