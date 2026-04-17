import { expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DataDir,
  PathEscapeError,
  assertSafeName,
  readToml,
  writeToml,
  appendNdjson,
  readNdjson,
} from "../src/storage/index.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bd-storage-"));
});

test("DataDir rejects path escapes", () => {
  const d = new DataDir(tmp);
  expect(() => d.path("..", "etc", "passwd")).toThrow(PathEscapeError);
  expect(() => d.path("sub/../..")).toThrow(PathEscapeError);
  // nested but still inside → ok
  expect(d.path("sub", "inner")).toBe(join(tmp, "sub", "inner"));
});

test("assertSafeName enforces charset", () => {
  expect(() => assertSafeName("ok_name.1-2", "x")).not.toThrow();
  expect(() => assertSafeName("../etc", "x")).toThrow();
  expect(() => assertSafeName("", "x")).toThrow();
  expect(() => assertSafeName("has space", "x")).toThrow();
  expect(() => assertSafeName(".hidden", "x")).toThrow();
});

test("TOML round-trip preserves arrays of tables (jump chain)", () => {
  const path = join(tmp, "m.toml");
  const data = {
    name: "m",
    host: "h",
    user: "u",
    key: "k",
    jump: [
      { host: "b1", user: "j", key: "bk1", port: 2022 },
      { host: "b2", user: "j", key: "bk2" },
    ],
  };
  writeToml(path, data);
  const parsed = readToml<typeof data>(path);
  expect(parsed.jump).toHaveLength(2);
  expect(parsed.jump[0]).toEqual({ host: "b1", user: "j", key: "bk1", port: 2022 });
  expect(parsed.jump[1]).toEqual({ host: "b2", user: "j", key: "bk2" });
});

test("TOML atomic write does not leave tmp files behind on success", () => {
  const path = join(tmp, "c.toml");
  writeToml(path, { a: 1 });
  const dirContents = readFileSync(path, "utf8");
  expect(dirContents).toContain("a = 1");
  // No .tmp- files should remain
  const { readdirSync } = require("node:fs");
  const entries: string[] = readdirSync(tmp);
  expect(entries.filter((e: string) => e.includes(".tmp-"))).toEqual([]);
});

test("NDJSON append + resume by offset", () => {
  const path = join(tmp, "log.ndjson");
  appendNdjson(path, { i: 1 });
  appendNdjson(path, { i: 2 });
  const first = readNdjson<{ i: number }>(path);
  expect(first.records).toEqual([{ i: 1 }, { i: 2 }]);
  appendNdjson(path, { i: 3 });
  const next = readNdjson<{ i: number }>(path, first.nextOffset);
  expect(next.records).toEqual([{ i: 3 }]);
  expect(next.nextOffset).toBeGreaterThan(first.nextOffset);
});

test("NDJSON ignores partial trailing line without newline", () => {
  const path = join(tmp, "partial.ndjson");
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path, '{"i":1}\n{"i":2} no newline here');
  const r = readNdjson<{ i: number }>(path);
  expect(r.records).toEqual([{ i: 1 }]);
  // Resuming from nextOffset should yield nothing until more data arrives.
  const again = readNdjson<{ i: number }>(path, r.nextOffset);
  expect(again.records).toEqual([]);
});

test("NDJSON on missing file returns empty", () => {
  const r = readNdjson(join(tmp, "nope.ndjson"));
  expect(r.records).toEqual([]);
  expect(r.nextOffset).toBe(0);
});
