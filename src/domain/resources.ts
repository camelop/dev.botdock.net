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
