import { existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DataDir, assertSafeName, readToml, writeToml, appendNdjson, readNdjson } from "../storage/index.ts";
import type { NdjsonReadResult } from "../storage/index.ts";

export type SessionStatus =
  | "provisioning"
  | "running"
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
  return readToml<Session>(p.meta);
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
    if (existsSync(metaPath)) out.push(readToml<Session>(metaPath));
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
