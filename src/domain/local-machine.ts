/**
 * Host-loopback pseudo-machine: instead of inventing a separate "run
 * commands on the host" code path, we stand up an SSH-to-localhost
 * machine called `local`. Every other part of the daemon (provisioning,
 * forwards, poller) treats it like any other remote.
 *
 * Enable flow:
 *   1. Generate an ed25519 key nicknamed `local` if one doesn't exist.
 *   2. Write machines/local.toml pointing at 127.0.0.1 with managed="local".
 *   3. Append the public key to ~/.ssh/authorized_keys if not already there.
 *   4. Clear any prior `disabled` flag.
 * The whole thing is idempotent — repeated Enable calls are no-ops.
 *
 * Disable flow:
 *   - Set disabled=true on the machine file.
 *   - Do NOT delete the machine, key, or authorized_keys line. The user
 *     can re-enable without regenerating keys or re-trusting.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, appendFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { DataDir } from "../storage/index.ts";
import { createKey, keyExists, readKey } from "./keys.ts";
import { readMachine, writeMachine, LOCAL_MACHINE_NAME, type Machine } from "./machines.ts";

export function enableLocalMachine(dir: DataDir): Machine {
  // 1. Ensure the key.
  if (!keyExists(dir, LOCAL_MACHINE_NAME)) {
    createKey(dir, LOCAL_MACHINE_NAME, "botdock-local-loopback");
  }

  // 2. Ensure the machine.
  let machine: Machine;
  try {
    machine = readMachine(dir, LOCAL_MACHINE_NAME);
    // Clear disabled flag on re-enable.
    if (machine.disabled) {
      machine = { ...machine, disabled: false };
      writeMachine(dir, machine);
    }
  } catch {
    const user = process.env.USER || userInfo().username;
    machine = {
      name: LOCAL_MACHINE_NAME,
      host: "127.0.0.1",
      port: 22,
      user,
      key: LOCAL_MACHINE_NAME,
      notes: "Managed loopback machine — runs agents on the host that's running `botdock serve`. Enable/Disable in the Machines page; re-enable preserves the key.",
      managed: "local",
    };
    writeMachine(dir, machine);
  }

  // 3. Ensure the public key is trusted by the local sshd.
  try {
    const { publicKey } = readKey(dir, LOCAL_MACHINE_NAME);
    ensureAuthorizedKeysEntry(publicKey);
  } catch (err) {
    throw new Error(
      `authorized_keys setup failed: ${err instanceof Error ? err.message : String(err)}. ` +
      `Key + machine entries were written; you can retry Enable after fixing the ssh config.`,
    );
  }

  return machine;
}

export function disableLocalMachine(dir: DataDir): Machine {
  const m = readMachine(dir, LOCAL_MACHINE_NAME);
  if (m.disabled) return m;
  const next: Machine = { ...m, disabled: true };
  writeMachine(dir, next);
  return next;
}

/**
 * Append the BotDock loopback pubkey to the running user's
 * ~/.ssh/authorized_keys. Creates the file (and ~/.ssh) with the
 * permissions sshd wants if they don't exist. No-op when the key is
 * already present so repeated Enable calls don't duplicate lines.
 */
function ensureAuthorizedKeysEntry(publicKey: string): void {
  const home = homedir();
  const sshDir = join(home, ".ssh");
  const authFile = join(sshDir, "authorized_keys");

  // Normalize the pubkey — single line, trim trailing whitespace.
  const line = publicKey.trim().split("\n")[0]!.trim();
  if (!line) throw new Error("public key is empty");

  // .ssh dir — 700 per sshd's requirement.
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }
  try { chmodSync(sshDir, 0o700); } catch { /* non-fatal */ }

  // authorized_keys — 600.
  let current = "";
  if (existsSync(authFile)) {
    current = readFileSync(authFile, "utf8");
  }
  // Match on the middle (base64 key body) — comment can differ.
  const keyBody = line.split(/\s+/)[1];
  if (keyBody && current.includes(keyBody)) {
    try { chmodSync(authFile, 0o600); } catch {}
    return;
  }

  // Append. If the file already exists, ensure we start on a new line.
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(authFile, `${prefix}${line}\n`, { mode: 0o600 });
  try { chmodSync(authFile, 0o600); } catch {}
  // Sanity: confirm it actually took.
  try {
    const st = statSync(authFile);
    if (st.size === 0) throw new Error("append produced an empty file");
  } catch (err) {
    throw new Error(`verify authorized_keys write: ${err instanceof Error ? err.message : String(err)}`);
  }
}
