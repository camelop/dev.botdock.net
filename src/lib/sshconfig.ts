import { writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DataDir } from "../storage/index.ts";
import type { Machine } from "../domain/machines.ts";

/** Path to a BotDock-managed known_hosts file (kept inside the data dir). */
export function knownHostsPath(dir: DataDir): string {
  dir.ensureDir("private");
  return dir.path("private", "known_hosts");
}

/**
 * Build a temp ssh config that pins per-hop identities and a ProxyJump chain.
 * Returns { configPath, targetAlias, dispose }. Caller must call dispose().
 */
export function buildSshConfig(dir: DataDir, machine: Machine): {
  configPath: string;
  targetAlias: string;
  dispose: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), "botdock-ssh-"));
  chmodSync(tmp, 0o700);
  const configPath = join(tmp, "config");
  const lines: string[] = [];

  const hopAliases: string[] = [];
  machine.jump?.forEach((hop, idx) => {
    const alias = `bd_hop_${idx}`;
    hopAliases.push(alias);
    const keyPath = dir.path("private", "keys", hop.key, "key");
    lines.push(
      `Host ${alias}`,
      `  HostName ${hop.host}`,
      `  User ${hop.user}`,
      `  Port ${hop.port ?? 22}`,
      `  IdentityFile ${keyPath}`,
      `  IdentitiesOnly yes`,
      "",
    );
  });

  const targetAlias = "bd_target";
  const targetKey = dir.path("private", "keys", machine.key, "key");
  lines.push(
    `Host ${targetAlias}`,
    `  HostName ${machine.host}`,
    `  User ${machine.user}`,
    `  Port ${machine.port ?? 22}`,
    `  IdentityFile ${targetKey}`,
    `  IdentitiesOnly yes`,
  );
  if (hopAliases.length) {
    lines.push(`  ProxyJump ${hopAliases.join(",")}`);
  }
  lines.push("");

  // Reuse TCP connections across ssh invocations targeting the same machine.
  // This matters a lot for session state polling (see src/lib/remote.ts).
  // The socket lives under /tmp because the kernel caps Unix-domain socket
  // paths at 108 chars; nesting it inside the data dir blew through that
  // limit once ssh appends its random temp suffix.
  const cmDir = join(tmpdir(), `botdock-cm-${userInfo().uid}`);
  mkdirSync(cmDir, { recursive: true, mode: 0o700 });
  try { chmodSync(cmDir, 0o700); } catch {}
  const controlPath = join(cmDir, "%C");

  lines.push(
    `Host *`,
    `  BatchMode yes`,
    `  ConnectTimeout 10`,
    `  StrictHostKeyChecking accept-new`,
    `  UserKnownHostsFile ${knownHostsPath(dir)}`,
    `  ServerAliveInterval 30`,
    `  ControlMaster auto`,
    `  ControlPath ${controlPath}`,
    `  ControlPersist 5m`,
    "",
  );

  writeFileSync(configPath, lines.join("\n"), { mode: 0o600 });

  return {
    configPath,
    targetAlias,
    dispose: () => {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    },
  };
}
