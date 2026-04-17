import { spawnSync } from "node:child_process";

export type RunResult = { code: number; stdout: string; stderr: string };

export function run(cmd: string, args: string[], input?: string): RunResult {
  const res = spawnSync(cmd, args, {
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Generate a passphrase-less ed25519 key pair into the given path. */
export function generateEd25519(keyPath: string, comment: string): void {
  const r = run("ssh-keygen", ["-q", "-t", "ed25519", "-f", keyPath, "-N", "", "-C", comment]);
  if (r.code !== 0) {
    throw new Error(`ssh-keygen failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

/** Compute SHA256 fingerprint of a key file (pub or priv). Returns `SHA256:…`. */
export function fingerprint(keyPath: string): string {
  const r = run("ssh-keygen", ["-lf", keyPath]);
  if (r.code !== 0) {
    throw new Error(`ssh-keygen -lf failed: ${r.stderr.trim()}`);
  }
  // Format: "256 SHA256:abc... comment (ED25519)"
  const parts = r.stdout.trim().split(/\s+/);
  const fp = parts[1];
  if (!fp || !fp.startsWith("SHA256:")) {
    throw new Error(`unexpected ssh-keygen output: ${r.stdout}`);
  }
  return fp;
}

/** Extract the public key for an existing private key. */
export function derivePublicKey(privKeyPath: string): string {
  const r = run("ssh-keygen", ["-y", "-f", privKeyPath]);
  if (r.code !== 0) {
    throw new Error(`ssh-keygen -y failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trimEnd() + "\n";
}
