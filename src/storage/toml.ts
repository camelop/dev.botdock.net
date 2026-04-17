import TOML from "@iarna/toml";
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export function readToml<T = Record<string, unknown>>(path: string): T {
  const raw = readFileSync(path, "utf8");
  return TOML.parse(raw) as unknown as T;
}

/**
 * Atomic write: serialize, write to a sibling temp file, fsync-free rename.
 * Good enough for our small config files; we rely on the rename being atomic
 * within the same directory.
 */
export function writeToml(path: string, data: Record<string, unknown>, opts?: { mode?: number }): void {
  const body = TOML.stringify(data as TOML.JsonMap);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, { encoding: "utf8" });
  if (opts?.mode !== undefined) chmodSync(tmp, opts.mode);
  renameSync(tmp, path);
}
