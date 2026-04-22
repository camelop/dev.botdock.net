/**
 * Pushing "context" resources from the BotDock root-folder into a session's
 * remote workdir. Layout on the remote mirrors the local root-folder 1:1
 * under `<workdir>/.botdock/context/` — the agent-side skill then sees the
 * same tree it would see locally, just under a different prefix, so no
 * mapping logic is needed on either side.
 *
 * Currently supported: git-repo. Keys ride along only when the selected
 * git-repo has a `deploy_key` and the user explicitly opted in — they are
 * never pushed standalone.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DataDir } from "../storage/index.ts";
import { readMachine } from "./machines.ts";
import { readGitRepo, readMarkdown, markdownExists } from "./resources.ts";
import { fileBundleExists } from "./file-bundles.ts";
import { readSession, appendEvent } from "./sessions.ts";
import { keyExists } from "./keys.ts";
import { sshExec, shSingleQuote } from "../lib/remote.ts";

export type GitRepoPick = {
  name: string;
  /** When true and the git-repo has a `deploy_key`, push the referenced
   *  key's files (including the private `key` at mode 600) alongside the
   *  repo meta so the agent can wire GIT_SSH_COMMAND without separate
   *  credential provisioning. */
  include_deploy_key: boolean;
};

export type MarkdownPick = {
  name: string;
};

export type FileBundlePick = {
  name: string;
};

export type ContextPushRequest = {
  git_repos: GitRepoPick[];
  markdowns: MarkdownPick[];
  file_bundles: FileBundlePick[];
};

export type PushedItem = {
  kind: "git-repo" | "keys" | "markdown" | "file-bundle";
  name: string;
  path: string;           // remote path (under context/)
  wrote_private_key?: boolean;
  /** For file-bundle: number of files written so the UI can show it. */
  file_count?: number;
};

export type ContextPushResult = {
  pushed: PushedItem[];
  /** Absolute path of the context root on the remote (with ~ already
   *  expanded by bash). Useful for the UI's success toast. */
  remote_base: string;
};

/** Files to write, as (relative-path, content-bytes, mode) tuples. The
 *  relative path is rooted at `<workdir>/.botdock/context/`. */
type FileSpec = { rel: string; bytes: Buffer; mode?: number };

export async function pushContext(
  dir: DataDir,
  sessionId: string,
  req: ContextPushRequest,
): Promise<ContextPushResult> {
  const session = readSession(dir, sessionId);
  const machine = readMachine(dir, session.machine);

  // Collect files + dedupe keys that get pulled in twice (e.g. two git-repos
  // sharing the same deploy_key). First occurrence wins; second is a no-op.
  const files: FileSpec[] = [];
  const pushed: PushedItem[] = [];
  const keysIncluded = new Map<string, PushedItem>();

  for (const pick of req.git_repos) {
    const repo = readGitRepo(dir, pick.name);
    const metaPath = join(dir.gitRepoDir(pick.name), "meta.toml");
    if (!existsSync(metaPath)) {
      throw new Error(`git-repo "${pick.name}" has no meta.toml on disk`);
    }
    files.push({
      rel: `resources/git-repo/${repo.name}/meta.toml`,
      bytes: readFileSync(metaPath),
    });
    pushed.push({
      kind: "git-repo",
      name: repo.name,
      path: `resources/git-repo/${repo.name}/`,
    });

    if (pick.include_deploy_key) {
      if (!repo.deploy_key) {
        throw new Error(`git-repo "${pick.name}" has no deploy_key configured`);
      }
      if (keysIncluded.has(repo.deploy_key)) continue;  // dedupe
      if (!keyExists(dir, repo.deploy_key)) {
        throw new Error(`deploy_key "${repo.deploy_key}" referenced by git-repo "${pick.name}" is missing`);
      }
      const keyBase = dir.keyDir(repo.deploy_key);
      files.push({ rel: `private/keys/${repo.deploy_key}/meta.toml`, bytes: readFileSync(join(keyBase, "meta.toml")) });
      files.push({ rel: `private/keys/${repo.deploy_key}/key.pub`, bytes: readFileSync(join(keyBase, "key.pub")) });
      files.push({ rel: `private/keys/${repo.deploy_key}/key`, bytes: readFileSync(join(keyBase, "key")), mode: 0o600 });
      const item: PushedItem = {
        kind: "keys",
        name: repo.deploy_key,
        path: `private/keys/${repo.deploy_key}/`,
        wrote_private_key: true,
      };
      keysIncluded.set(repo.deploy_key, item);
      pushed.push(item);
    }
  }

  for (const pick of req.markdowns) {
    if (!markdownExists(dir, pick.name)) {
      throw new Error(`markdown "${pick.name}" not found`);
    }
    const mk = readMarkdown(dir, pick.name);
    const base = dir.markdownDir(pick.name);
    files.push({
      rel: `resources/markdown/${mk.meta.name}/meta.toml`,
      bytes: readFileSync(join(base, "meta.toml")),
    });
    files.push({
      rel: `resources/markdown/${mk.meta.name}/content.md`,
      bytes: Buffer.from(mk.content, "utf8"),
    });
    pushed.push({
      kind: "markdown",
      name: mk.meta.name,
      path: `resources/markdown/${mk.meta.name}/`,
    });
  }

  for (const pick of req.file_bundles) {
    if (!fileBundleExists(dir, pick.name)) {
      throw new Error(`file-bundle "${pick.name}" not found`);
    }
    const base = dir.fileBundleDir(pick.name);
    const metaRel = `resources/file-bundle/${pick.name}/meta.toml`;
    files.push({
      rel: metaRel,
      bytes: readFileSync(join(base, "meta.toml")),
    });
    const contentRoot = join(base, "content");
    let fileCount = 0;
    if (existsSync(contentRoot)) {
      // Walk the bundle's content tree. For v1 we reuse the base64-heredoc
      // path (same as git-repo / markdown) — simple, one sshExec call.
      // Very large bundles will be slow; streaming tar-over-ssh is the
      // follow-up if size becomes a bottleneck.
      const stack: Array<{ abs: string; rel: string }> = [{ abs: contentRoot, rel: "" }];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const entry of readdirSync(cur.abs)) {
          const abs = join(cur.abs, entry);
          const rel = cur.rel ? `${cur.rel}/${entry}` : entry;
          const st = statSync(abs);
          if (st.isDirectory()) stack.push({ abs, rel });
          else if (st.isFile()) {
            files.push({
              rel: `resources/file-bundle/${pick.name}/content/${rel}`,
              bytes: readFileSync(abs),
            });
            fileCount += 1;
          }
        }
      }
    }
    pushed.push({
      kind: "file-bundle",
      name: pick.name,
      path: `resources/file-bundle/${pick.name}/`,
      file_count: fileCount,
    });
  }

  if (files.length === 0) {
    throw new Error("nothing selected to push");
  }

  const script = buildPushScript(session.workdir, files);
  const res = sshExec(dir, machine, "bash -s", script, 60_000);
  if (res.code !== 0) {
    throw new Error(`remote push failed (ssh exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const marker = "BOTDOCK_CONTEXT_PUSHED:";
  const line = res.stdout.split("\n").find((l) => l.startsWith(marker));
  const remoteBase = line ? line.slice(marker.length).trim() : "";

  // Audit trail — the event log records exactly what was written and
  // whether any private key material left the host. Viewable in the
  // Events panel of the session.
  appendEvent(dir, sessionId, {
    ts: new Date().toISOString(),
    kind: "context_push",
    remote_base: remoteBase,
    items: pushed,
  });

  return { pushed, remote_base: remoteBase };
}

/**
 * Build a bash script that:
 *   1. resolves `~/...` in the workdir against $HOME,
 *   2. creates the context root at 700,
 *   3. writes every file via base64 heredoc (binary-safe),
 *   4. chmods private-key files to 600 / their parent dirs to 700,
 *   5. prints a marker with the absolute remote path on success.
 *
 * Heredoc delimiter is a unique per-file tag; content is base64 so no
 * character in the file can collide with the delimiter or the shell.
 */
function buildPushScript(workdir: string, files: FileSpec[]): string {
  const wq = shSingleQuote(workdir);
  const parts: string[] = [];
  parts.push("#!/bin/bash");
  parts.push("set -euo pipefail");
  parts.push(`WORKDIR=${wq}`);
  parts.push(`case "$WORKDIR" in`);
  parts.push(`  "~")   WORKDIR="$HOME" ;;`);
  parts.push(`  "~/"*) WORKDIR="$HOME$(printf '%s' "$WORKDIR" | cut -c2-)" ;;`);
  parts.push(`esac`);
  parts.push(`BASE="$WORKDIR/.botdock/context"`);
  parts.push(`mkdir -p "$BASE"`);
  parts.push(`chmod 700 "$BASE" || true`);

  // Collect unique parent dirs so we mkdir -p once per dir, deterministically.
  const dirs = new Set<string>();
  for (const f of files) {
    const parent = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
    if (parent) dirs.add(parent);
  }
  for (const d of Array.from(dirs).sort()) {
    parts.push(`mkdir -p "$BASE/${d}"`);
  }
  // Any private/keys/<name>/ dir must be 700 — covers both existing dirs
  // (re-push) and just-created ones.
  for (const d of Array.from(dirs).sort()) {
    if (d.startsWith("private/keys/")) parts.push(`chmod 700 "$BASE/${d}" || true`);
  }

  files.forEach((f, i) => {
    const tag = `BDCTX_${i}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const b64 = f.bytes.toString("base64");
    parts.push(`base64 -d > "$BASE/${f.rel}" <<'${tag}'`);
    // Chunk the base64 into 76-char lines so heredocs stay readable in
    // transit logs and don't trip on any single-line length limits.
    parts.push(b64.match(/.{1,76}/g)?.join("\n") ?? b64);
    parts.push(tag);
    if (f.mode !== undefined) {
      const octal = f.mode.toString(8).padStart(3, "0");
      parts.push(`chmod ${octal} "$BASE/${f.rel}"`);
    }
  });

  parts.push(`echo "BOTDOCK_CONTEXT_PUSHED:$BASE"`);
  return parts.join("\n") + "\n";
}
