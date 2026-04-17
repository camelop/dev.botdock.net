import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { DataDir, assertSafeName, readToml, writeToml } from "../storage/index.ts";
import { generateEd25519, fingerprint, derivePublicKey } from "../lib/ssh.ts";

export type KeyMeta = {
  nickname: string;
  created_at: string;
  fingerprint: string;
  comment: string;
  source: "generated" | "imported";
};

function paths(dir: DataDir, nickname: string) {
  const base = dir.keyDir(nickname);
  return {
    base,
    key: join(base, "key"),
    pub: join(base, "key.pub"),
    meta: join(base, "meta.toml"),
  };
}

export function keyExists(dir: DataDir, nickname: string): boolean {
  return existsSync(paths(dir, nickname).meta);
}

export function listKeys(dir: DataDir): KeyMeta[] {
  const root = dir.keysDir();
  if (!existsSync(root)) return [];
  const out: KeyMeta[] = [];
  for (const name of readdirSync(root)) {
    try {
      assertSafeName(name, "key nickname");
    } catch {
      continue;
    }
    const metaPath = join(root, name, "meta.toml");
    if (existsSync(metaPath)) out.push(readToml<KeyMeta>(metaPath));
  }
  out.sort((a, b) => a.nickname.localeCompare(b.nickname));
  return out;
}

export function readKey(dir: DataDir, nickname: string): { meta: KeyMeta; publicKey: string } {
  const p = paths(dir, nickname);
  if (!existsSync(p.meta)) throw new Error(`key not found: ${nickname}`);
  return {
    meta: readToml<KeyMeta>(p.meta),
    publicKey: readFileSync(p.pub, "utf8"),
  };
}

export function createKey(dir: DataDir, nickname: string, comment: string): KeyMeta {
  assertSafeName(nickname, "key nickname");
  const p = paths(dir, nickname);
  if (existsSync(p.base)) throw new Error(`key already exists: ${nickname}`);
  mkdirSync(p.base, { recursive: true, mode: 0o700 });
  chmodSync(p.base, 0o700);
  generateEd25519(p.key, comment);
  chmodSync(p.key, 0o600);
  const meta: KeyMeta = {
    nickname,
    created_at: new Date().toISOString(),
    fingerprint: fingerprint(p.pub),
    comment,
    source: "generated",
  };
  writeToml(p.meta, meta as unknown as Record<string, unknown>);
  return meta;
}

export function importKey(dir: DataDir, nickname: string, privKeyPath: string, comment: string): KeyMeta {
  assertSafeName(nickname, "key nickname");
  const p = paths(dir, nickname);
  if (existsSync(p.base)) throw new Error(`key already exists: ${nickname}`);
  const priv = readFileSync(privKeyPath);
  mkdirSync(p.base, { recursive: true, mode: 0o700 });
  chmodSync(p.base, 0o700);
  writeFileSync(p.key, priv, { mode: 0o600 });
  const pub = derivePublicKey(p.key);
  writeFileSync(p.pub, pub, { mode: 0o644 });
  const meta: KeyMeta = {
    nickname,
    created_at: new Date().toISOString(),
    fingerprint: fingerprint(p.pub),
    comment,
    source: "imported",
  };
  writeToml(p.meta, meta as unknown as Record<string, unknown>);
  return meta;
}

export function deleteKey(dir: DataDir, nickname: string): void {
  const p = paths(dir, nickname);
  if (!existsSync(p.base)) throw new Error(`key not found: ${nickname}`);
  rmSync(p.base, { recursive: true, force: true });
}
