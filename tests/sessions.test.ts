import { expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDir } from "../src/storage/index.ts";
import { runInit } from "../src/commands/init.ts";
import {
  appendEvent,
  appendRaw,
  createSessionRecord,
  listSessions,
  readEvents,
  readRawRange,
  readSession,
  sessionExists,
  updateSession,
} from "../src/domain/sessions.ts";

let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bd-sessions-"));
  await runInit({ home: tmp, args: [] });
});

test("create → read → list; tmux name has botdock- prefix", () => {
  const dir = new DataDir(tmp);
  const s = createSessionRecord(dir, {
    machine: "m",
    workdir: "/srv/work",
    agent_kind: "generic-cmd",
    cmd: "sleep 1",
  });
  expect(s.status).toBe("provisioning");
  expect(s.tmux_session).toMatch(/^botdock-[a-f0-9]{8}$/);
  expect(sessionExists(dir, s.id)).toBe(true);
  const loaded = readSession(dir, s.id);
  expect(loaded.cmd).toBe("sleep 1");
  expect(listSessions(dir).map((x) => x.id)).toEqual([s.id]);
});

test("events are appended with 'created' + custom kinds and readable by offset", () => {
  const dir = new DataDir(tmp);
  const s = createSessionRecord(dir, {
    machine: "m", workdir: "/x", agent_kind: "generic-cmd", cmd: "true",
  });
  appendEvent(dir, s.id, { ts: "2026-01-01T00:00:00Z", kind: "started", pid: 1234 });
  appendEvent(dir, s.id, { ts: "2026-01-01T00:00:01Z", kind: "exited", exit_code: 0 });
  const r = readEvents(dir, s.id);
  expect(r.records.map((e) => e.kind)).toEqual(["created", "started", "exited"]);
  // Resume from offset — no new records if nothing appended.
  const again = readEvents(dir, s.id, r.nextOffset);
  expect(again.records).toEqual([]);
});

test("raw bytes append and read by offset", () => {
  const dir = new DataDir(tmp);
  const s = createSessionRecord(dir, {
    machine: "m", workdir: "/x", agent_kind: "generic-cmd", cmd: "true",
  });
  appendRaw(dir, s.id, "hello ");
  appendRaw(dir, s.id, Buffer.from("world"));
  const all = readRawRange(dir, s.id);
  expect(all.data).toBe("hello world");
  expect(all.size).toBe(11);
  const tail = readRawRange(dir, s.id, 6);
  expect(tail.data).toBe("world");
});

test("updateSession patches fields and persists", () => {
  const dir = new DataDir(tmp);
  const s = createSessionRecord(dir, {
    machine: "m", workdir: "/x", agent_kind: "generic-cmd", cmd: "true",
  });
  updateSession(dir, s.id, { status: "running", started_at: "2026-02-02T00:00:00Z" });
  const loaded = readSession(dir, s.id);
  expect(loaded.status).toBe("running");
  expect(loaded.started_at).toBe("2026-02-02T00:00:00Z");
});
