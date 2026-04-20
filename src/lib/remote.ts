import { spawnSync } from "node:child_process";
import type { Machine } from "../domain/machines.ts";
import { DataDir } from "../storage/index.ts";
import { buildSshConfig } from "./sshconfig.ts";

export type RemoteResult = { code: number; stdout: string; stderr: string };

export type SshExecOpts = {
  /** Skip the ControlMaster mux for this call. Use for long-running bootstraps
   * (e.g. provisioning new sessions) — the mux otherwise serializes this
   * call and delays concurrent pollers/forwards for the same machine. */
  noControlMaster?: boolean;
};

export function sshExec(
  dir: DataDir,
  machine: Machine,
  command: string,
  input?: string,
  timeoutMs = 30_000,
  opts: SshExecOpts = {},
): RemoteResult {
  const cfg = buildSshConfig(dir, machine);
  try {
    const extra = opts.noControlMaster
      ? ["-o", "ControlMaster=no", "-o", "ControlPath=none"]
      : [];
    const res = spawnSync(
      "ssh",
      ["-F", cfg.configPath, ...extra, cfg.targetAlias, command],
      { input, encoding: "utf8", timeout: timeoutMs },
    );
    if (res.error) throw res.error;
    return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } finally {
    cfg.dispose();
  }
}

/** Shell-escape a string so it is safe inside a double-quoted shell context. */
export function shDoubleQuote(s: string): string {
  return s.replace(/(["\\$`])/g, "\\$1");
}

/** Single-quote a string for shell, handling embedded quotes. */
export function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
