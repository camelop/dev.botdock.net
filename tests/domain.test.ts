import { expect, test, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDir } from "../src/storage/index.ts";
import { runInit } from "../src/commands/init.ts";
import { createKey, deleteKey, keyExists, listKeys, readKey } from "../src/domain/keys.ts";
import {
  deleteMachine,
  listMachines,
  readMachine,
  writeMachine,
} from "../src/domain/machines.ts";
import {
  deleteSecret,
  listSecrets,
  readSecretValue,
  writeSecret,
} from "../src/domain/secrets.ts";
import { buildSshConfig } from "../src/lib/sshconfig.ts";

let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bd-domain-"));
  await runInit({ home: tmp, args: [] });
});

test("init scaffolds full layout and 0700 on private/", () => {
  const dir = new DataDir(tmp);
  expect(existsSync(dir.configFile())).toBe(true);
  expect(existsSync(dir.keysDir())).toBe(true);
  expect(existsSync(dir.secretsDir())).toBe(true);
  expect(existsSync(dir.machinesDir())).toBe(true);
  expect(existsSync(dir.sessionsDir())).toBe(true);
  expect(existsSync(dir.path("resources", "git-repo"))).toBe(true);
  expect(existsSync(dir.path("resources", "markdown"))).toBe(true);
  expect(existsSync(dir.path("resources", "file-bundle"))).toBe(true);
  const mode = statSync(dir.path("private")).mode & 0o777;
  expect(mode).toBe(0o700);
});

test("key create → list → read → delete round-trip", () => {
  const dir = new DataDir(tmp);
  const meta = createKey(dir, "k1", "test");
  expect(meta.fingerprint.startsWith("SHA256:")).toBe(true);
  expect(keyExists(dir, "k1")).toBe(true);
  const pub = readKey(dir, "k1").publicKey;
  expect(pub).toMatch(/^ssh-ed25519 /);
  expect(statSync(dir.path("private", "keys", "k1", "key")).mode & 0o777).toBe(0o600);
  expect(listKeys(dir).map((k) => k.nickname)).toEqual(["k1"]);
  deleteKey(dir, "k1");
  expect(keyExists(dir, "k1")).toBe(false);
});

test("key create rejects duplicate nickname", () => {
  const dir = new DataDir(tmp);
  createKey(dir, "dup", "x");
  expect(() => createKey(dir, "dup", "x")).toThrow(/already exists/);
});

test("machine round-trip with jump chain; key refs validated", () => {
  const dir = new DataDir(tmp);
  createKey(dir, "target-key", "t");
  createKey(dir, "hop-key", "h");
  writeMachine(dir, {
    name: "m1",
    host: "10.0.0.5",
    user: "u",
    key: "target-key",
    port: 2022,
    tags: ["a", "b"],
    jump: [{ host: "bastion", user: "j", key: "hop-key", port: 2222 }],
  });
  const read = readMachine(dir, "m1");
  expect(read.jump).toHaveLength(1);
  expect(read.jump?.[0]?.key).toBe("hop-key");
  expect(listMachines(dir).map((m) => m.name)).toEqual(["m1"]);

  // Referencing an unknown key should fail.
  expect(() =>
    writeMachine(dir, { name: "bad", host: "x", user: "u", key: "nope" }),
  ).toThrow(/key nickname not found/);

  deleteMachine(dir, "m1");
  expect(listMachines(dir)).toEqual([]);
});

test("secret set → list → read → update preserves created_at", async () => {
  const dir = new DataDir(tmp);
  const m1 = writeSecret(dir, "s1", Buffer.from("v1"), "desc");
  expect(statSync(dir.path("private", "secrets", "s1", "value")).mode & 0o777).toBe(0o600);
  await new Promise((r) => setTimeout(r, 10));
  const m2 = writeSecret(dir, "s1", Buffer.from("v2-longer"), "desc2");
  expect(m2.created_at).toBe(m1.created_at);
  expect(m2.updated_at).not.toBe(m1.updated_at);
  expect(m2.byte_length).toBe("v2-longer".length);
  expect(readSecretValue(dir, "s1").toString()).toBe("v2-longer");
  expect(listSecrets(dir).map((s) => s.name)).toEqual(["s1"]);
  deleteSecret(dir, "s1");
  expect(listSecrets(dir)).toEqual([]);
});

test("buildSshConfig wires per-hop IdentityFile + ProxyJump chain", () => {
  const dir = new DataDir(tmp);
  createKey(dir, "tk", "t");
  createKey(dir, "h1k", "h1");
  createKey(dir, "h2k", "h2");
  writeMachine(dir, {
    name: "m",
    host: "target.example",
    user: "ubuntu",
    key: "tk",
    jump: [
      { host: "hop1.example", user: "j1", key: "h1k" },
      { host: "hop2.example", user: "j2", key: "h2k", port: 2222 },
    ],
  });
  const m = readMachine(dir, "m");
  const cfg = buildSshConfig(dir, m);
  try {
    const text = readFileSync(cfg.configPath, "utf8");
    expect(text).toContain("Host bd_hop_0");
    expect(text).toContain("HostName hop1.example");
    expect(text).toContain("Host bd_hop_1");
    expect(text).toContain("Port 2222");
    expect(text).toContain(`IdentityFile ${dir.path("private", "keys", "h2k", "key")}`);
    expect(text).toContain("Host bd_target");
    expect(text).toContain("ProxyJump bd_hop_0,bd_hop_1");
    expect(text).toContain("StrictHostKeyChecking accept-new");
  } finally {
    cfg.dispose();
  }
});
