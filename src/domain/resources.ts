/**
 * Reusable context resources — stuff the user curates once and attaches
 * to individual sessions later (via a future push action). Three kinds
 * are planned; git-repo is the first landing.
 *
 * Names are unique across ALL resource kinds (a git-repo and a markdown
 * can't share a name). resources/<kind>/<name>/ is the canonical layout;
 * meta.toml holds the kind-specific schema.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DataDir, assertSafeName, readToml, writeToml } from "../storage/index.ts";
import { keyExists } from "./keys.ts";

export type ResourceKind = "git-repo" | "markdown" | "file-bundle";

// Every resource kind has its own directory under resources/. Listing all
// kinds here keeps the global-uniqueness scan and the new-kind wiring in
// one place.
const RESOURCE_KINDS: ResourceKind[] = ["git-repo", "markdown", "file-bundle"];

function kindDir(dir: DataDir, kind: ResourceKind): string {
  return join(dir.resourcesDir(), kind);
}

/**
 * True if `name` is already in use by ANY resource kind. Used to enforce
 * the global-uniqueness rule at create time.
 */
export function resourceNameInUse(dir: DataDir, name: string): ResourceKind | null {
  for (const k of RESOURCE_KINDS) {
    if (existsSync(join(kindDir(dir, k), name, "meta.toml"))) return k;
  }
  return null;
}

// ---- git-repo ------------------------------------------------------------

export type GitRepoResource = {
  name: string;
  url: string;
  ref?: string;
  deploy_key?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
};

export function listGitRepos(dir: DataDir): GitRepoResource[] {
  const root = kindDir(dir, "git-repo");
  if (!existsSync(root)) return [];
  const out: GitRepoResource[] = [];
  for (const name of readdirSync(root)) {
    try { assertSafeName(name, "git-repo name"); } catch { continue; }
    const meta = join(root, name, "meta.toml");
    if (!existsSync(meta)) continue;
    out.push(readToml<GitRepoResource>(meta));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function readGitRepo(dir: DataDir, name: string): GitRepoResource {
  const meta = join(dir.gitRepoDir(name), "meta.toml");
  if (!existsSync(meta)) throw new Error(`git-repo not found: ${name}`);
  return readToml<GitRepoResource>(meta);
}

export function gitRepoExists(dir: DataDir, name: string): boolean {
  try { return existsSync(join(dir.gitRepoDir(name), "meta.toml")); }
  catch { return false; }
}

export function writeGitRepo(dir: DataDir, r: GitRepoResource): void {
  assertSafeName(r.name, "git-repo name");
  if (!r.url || !r.url.trim()) throw new Error("url required");
  if (r.deploy_key && !keyExists(dir, r.deploy_key)) {
    throw new Error(`referenced deploy_key not found: ${r.deploy_key}`);
  }
  const data: Record<string, unknown> = {
    name: r.name,
    url: r.url,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (r.ref)        data.ref = r.ref;
  if (r.deploy_key) data.deploy_key = r.deploy_key;
  if (r.tags && r.tags.length) data.tags = r.tags;
  writeToml(join(dir.gitRepoDir(r.name), "meta.toml"), data);
}

export function deleteGitRepo(dir: DataDir, name: string): void {
  const path = dir.gitRepoDir(name);
  if (!existsSync(path)) throw new Error(`git-repo not found: ${name}`);
  rmSync(path, { recursive: true, force: true });
}

export type GitRepoProbe = {
  default_branch: string | null;
  branches: string[];
};

/**
 * Run `git ls-remote --symref <url>` to discover the default branch and
 * all branch heads. If `deployKey` is supplied we select it via
 * `GIT_SSH_COMMAND` so private repos probe without leaking to the user's
 * default ssh-agent. Accepts new host keys on first contact — matches the
 * ssh-config precedent in src/lib/sshconfig.ts.
 */
export function probeGitRepo(dir: DataDir, url: string, deployKey?: string): GitRepoProbe {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("url required");
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (deployKey) {
    if (!keyExists(dir, deployKey)) {
      throw new Error(`deploy_key not found: ${deployKey}`);
    }
    const keyPath = join(dir.keyDir(deployKey), "key");
    env.GIT_SSH_COMMAND = [
      "ssh",
      "-i", keyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "BatchMode=yes",
    ].join(" ");
  } else {
    env.GIT_SSH_COMMAND = [
      "ssh",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "BatchMode=yes",
    ].join(" ");
  }
  // Short-circuit any askpass prompt — probe should never hang on creds.
  env.GIT_TERMINAL_PROMPT = "0";

  const res = spawnSync("git", ["ls-remote", "--symref", trimmed], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (res.error) throw res.error;
  if ((res.status ?? -1) !== 0) {
    const msg = (res.stderr ?? "").trim() || (res.stdout ?? "").trim() || `git ls-remote exited ${res.status}`;
    throw new Error(msg);
  }
  return parseLsRemote(res.stdout ?? "");
}

function parseLsRemote(out: string): GitRepoProbe {
  let defaultBranch: string | null = null;
  const branches: string[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("ref: ")) {
      // "ref: refs/heads/<b>\tHEAD"
      const m = line.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/);
      if (m) defaultBranch = m[1]!;
      continue;
    }
    // "<sha>\trefs/heads/<b>" — ignore tags and HEAD deref line.
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const ref = parts[1]!;
    if (ref.startsWith("refs/heads/")) {
      branches.push(ref.slice("refs/heads/".length));
    }
  }
  branches.sort((a, b) => a.localeCompare(b));
  return { default_branch: defaultBranch, branches };
}
