import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { DataDir, assertSafeName, readToml, writeToml } from "../storage/index.ts";

export type SecretMeta = {
  name: string;
  created_at: string;
  updated_at: string;
  description: string;
  byte_length: number;
};

function paths(dir: DataDir, name: string) {
  const base = dir.secretDir(name);
  return { base, value: join(base, "value"), meta: join(base, "meta.toml") };
}

export function listSecrets(dir: DataDir): SecretMeta[] {
  const root = dir.secretsDir();
  if (!existsSync(root)) return [];
  const out: SecretMeta[] = [];
  for (const name of readdirSync(root)) {
    try { assertSafeName(name, "secret name"); } catch { continue; }
    const metaPath = join(root, name, "meta.toml");
    if (existsSync(metaPath)) out.push(readToml<SecretMeta>(metaPath));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function readSecretValue(dir: DataDir, name: string): Buffer {
  const p = paths(dir, name);
  if (!existsSync(p.value)) throw new Error(`secret not found: ${name}`);
  return readFileSync(p.value);
}

export function readSecretMeta(dir: DataDir, name: string): SecretMeta {
  const p = paths(dir, name);
  if (!existsSync(p.meta)) throw new Error(`secret not found: ${name}`);
  return readToml<SecretMeta>(p.meta);
}

export function writeSecret(
  dir: DataDir,
  name: string,
  value: Buffer,
  description: string,
): SecretMeta {
  assertSafeName(name, "secret name");
  const p = paths(dir, name);
  const existed = existsSync(p.meta);
  mkdirSync(p.base, { recursive: true, mode: 0o700 });
  chmodSync(p.base, 0o700);
  writeFileSync(p.value, value, { mode: 0o600 });
  chmodSync(p.value, 0o600);
  const now = new Date().toISOString();
  const created_at = existed ? readToml<SecretMeta>(p.meta).created_at : now;
  const meta: SecretMeta = {
    name,
    created_at,
    updated_at: now,
    description,
    byte_length: statSync(p.value).size,
  };
  writeToml(p.meta, meta as unknown as Record<string, unknown>);
  return meta;
}

export function deleteSecret(dir: DataDir, name: string): void {
  const p = paths(dir, name);
  if (!existsSync(p.base)) throw new Error(`secret not found: ${name}`);
  rmSync(p.base, { recursive: true, force: true });
}
