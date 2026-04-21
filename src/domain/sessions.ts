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
  /** Last observed size of the remote CC jsonl. When offset < size, the
   * poller is still draining a backlog — activity is surfaced as "syncing"
   * so the UI doesn't mis-flag a catch-up period as "running". */
  remote_transcript_size?: number;
  /** Wallclock timestamps of the last time the poller saw growth in each
   * stream. Used by the activity-state heuristic. */
  last_raw_at?: string;
  last_transcript_at?: string;
  /** Derived activity (only meaningful for active claude-code sessions):
   *   "running" = agent is producing output / using a tool,
   *   "pending" = agent has completed its turn, awaiting the user,
   *   "syncing" = BotDock hasn't finished mirroring the remote transcript
   *               yet — the last-entry heuristic can't be trusted until
   *               we're caught up. */
  activity?: "running" | "pending" | "syncing";
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
  /** User-chosen tags. A session with N tags is shown N times in the
   * Workspace sidebar (once under each tag group); selection is keyed on
   * session id so every appearance highlights together. */
  tags?: string[];
  /** For claude-code: advanced override for the binary+args the shim runs.
   * Defaults to "claude" when empty. Word-split into argv (so "claude -v"
   * yields two args). Useful when the user wants to pin a specific
   * binary path, a model flag, or a verbose mode. */
  launch_command?: string;
  /** For claude-code: export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 before
   * launching claude. Opt-in; default unset behaves identically to before. */
  cc_agent_teams?: boolean;
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
    launch_command?: string;
    cc_agent_teams?: boolean;
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
    ...(args.launch_command && args.launch_command.trim() ? { launch_command: args.launch_command.trim() } : {}),
    ...(args.cc_agent_teams ? { cc_agent_teams: true } : {}),
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

/**
 * Paginated view over the local transcript.ndjson. Scans the file to count
 * line breaks, then returns the requested page of raw JSONL lines. The UI
 * uses this instead of shipping the entire transcript over the WS every
 * time the user opens a session — for resumed CC conversations that
 * transcript is frequently multi-MB, and parsing it all up front stalls
 * the right pane of SessionView.
 */
export function readTranscriptPage(
  dir: DataDir,
  id: string,
  opts: { page: number; pageSize: number },
): {
  line_count: number;
  total_pages: number;
  page_index: number;
  page_size: number;
  start: number;
  end: number;
  text: string;
} {
  const p = paths(dir, id).transcript;
  const pageSize = Math.max(1, Math.min(500, Math.floor(opts.pageSize || 20)));

  let size = 0;
  try { size = statSync(p).size; } catch {
    return { line_count: 0, total_pages: 0, page_index: 0, page_size: pageSize, start: 0, end: 0, text: "" };
  }
  if (size === 0) {
    return { line_count: 0, total_pages: 0, page_index: 0, page_size: pageSize, start: 0, end: 0, text: "" };
  }

  const { openSync, readSync, closeSync } = require("node:fs") as typeof import("node:fs");

  // First pass: count lines (\n bytes; also count a trailing line if the
  // file doesn't end in \n). Scans in 64 KiB chunks so multi-MB files stay
  // bounded in memory.
  let lineCount = 0;
  let lastByte = 0;
  {
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      let remaining = size;
      while (remaining > 0) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, remaining), null);
        if (n <= 0) break;
        for (let i = 0; i < n; i++) if (buf[i] === 10) lineCount++;
        lastByte = buf[n - 1]!;
        remaining -= n;
      }
    } finally { closeSync(fd); }
    if (lastByte !== 10) lineCount++;  // trailing non-terminated line
  }
  if (lineCount === 0) {
    return { line_count: 0, total_pages: 0, page_index: 0, page_size: pageSize, start: 0, end: 0, text: "" };
  }

  const totalPages = Math.ceil(lineCount / pageSize);
  // Clamp page — "last page" sentinel: callers can pass a huge number to get
  // the newest page without doing the math client-side.
  const pageIndex = Math.max(0, Math.min(totalPages - 1, Math.floor(opts.page ?? 0)));
  const start = pageIndex * pageSize;
  const end = Math.min(lineCount, start + pageSize);

  // Second pass: extract the requested line range. For simplicity, read the
  // whole file once into a buffer. Transcripts up to a few MB are fine here;
  // if this becomes a hot path we can switch to offset-indexed chunked reads.
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const text = (readFileSync(p, "utf8") as string);
  // split on \n — for a file ending with \n this yields N+1 entries with
  // the last being "", which slice() happily skips.
  const allLines = text.split("\n");
  const wanted = allLines.slice(start, end).filter((l) => l.length > 0);

  return {
    line_count: lineCount,
    total_pages: totalPages,
    page_index: pageIndex,
    page_size: pageSize,
    start,
    end,
    text: wanted.join("\n"),
  };
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
