/**
 * Pushing "context" resources from the BotDock root-folder into a session's
 * remote workdir. Layout on the remote mirrors the local root-folder 1:1
 * under `<workdir>/.botdock/context/` — the agent-side skill then sees the
 * same tree it would see locally, just under a different prefix, so no
 * mapping logic is needed on either side.
 *
 * Transport is rsync-over-ssh (reusing our per-machine ssh config with
 * ControlMaster + ProxyJump, so jump hosts and multiplexing still work).
 * We pre-collect the list of relative paths from `dir.root` that need
 * to land on the remote, hand them to a single `rsync --files-from`
 * invocation, and let rsync do incremental transfer + mode preservation.
 *
 * Supported resources:
 *   - git-repo → resources/git-repo/<name>/meta.toml
 *   - markdown → resources/markdown/<name>/{meta.toml,content.md}
 *   - file-bundle → resources/file-bundle/<name>/{meta.toml, content/**}
 *   - keys (pulled in by a git-repo's include_deploy_key opt-in) →
 *         private/keys/<name>/{meta.toml,key.pub,key}   (key mode 600)
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DataDir } from "../storage/index.ts";
import { readMachine } from "./machines.ts";
import { readGitRepo } from "./resources.ts";
import { markdownExists } from "./resources.ts";
import { fileBundleExists } from "./file-bundles.ts";
import { readSession, appendEvent } from "./sessions.ts";
import { keyExists } from "./keys.ts";
import { sshExec, shSingleQuote } from "../lib/remote.ts";
import { buildSshConfig } from "../lib/sshconfig.ts";

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
  /** Rough tally for the UI — how many rsync'd paths total. */
  transferred_files: number;
};

export async function pushContext(
  dir: DataDir,
  sessionId: string,
  req: ContextPushRequest,
): Promise<ContextPushResult> {
  const session = readSession(dir, sessionId);
  const machine = readMachine(dir, session.machine);

  // Collect every path (relative to dir.root) that must land on the remote.
  // Pair each with the PushedItem it belongs to so we can report back what
  // actually got written.
  const relPaths: string[] = [];
  const pushed: PushedItem[] = [];
  const keysIncluded = new Map<string, PushedItem>();

  const pushFile = (rel: string) => {
    const abs = join(dir.root, rel);
    if (!existsSync(abs)) throw new Error(`expected source file missing: ${rel}`);
    relPaths.push(rel);
  };

  for (const pick of req.git_repos) {
    const repo = readGitRepo(dir, pick.name);
    pushFile(`resources/git-repo/${repo.name}/meta.toml`);
    pushed.push({
      kind: "git-repo",
      name: repo.name,
      path: `resources/git-repo/${repo.name}/`,
    });
    if (pick.include_deploy_key) {
      if (!repo.deploy_key) {
        throw new Error(`git-repo "${pick.name}" has no deploy_key configured`);
      }
      if (keysIncluded.has(repo.deploy_key)) continue;
      if (!keyExists(dir, repo.deploy_key)) {
        throw new Error(`deploy_key "${repo.deploy_key}" referenced by git-repo "${pick.name}" is missing`);
      }
      pushFile(`private/keys/${repo.deploy_key}/meta.toml`);
      pushFile(`private/keys/${repo.deploy_key}/key.pub`);
      pushFile(`private/keys/${repo.deploy_key}/key`);
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
    pushFile(`resources/markdown/${pick.name}/meta.toml`);
    pushFile(`resources/markdown/${pick.name}/content.md`);
    pushed.push({
      kind: "markdown",
      name: pick.name,
      path: `resources/markdown/${pick.name}/`,
    });
  }

  for (const pick of req.file_bundles) {
    if (!fileBundleExists(dir, pick.name)) {
      throw new Error(`file-bundle "${pick.name}" not found`);
    }
    const bundleRoot = dir.fileBundleDir(pick.name);
    pushFile(`resources/file-bundle/${pick.name}/meta.toml`);
    const contentRoot = join(bundleRoot, "content");
    let fileCount = 0;
    if (existsSync(contentRoot)) {
      for (const abs of walkFiles(contentRoot)) {
        const rel = relative(dir.root, abs);
        relPaths.push(rel);
        fileCount += 1;
      }
    }
    pushed.push({
      kind: "file-bundle",
      name: pick.name,
      path: `resources/file-bundle/${pick.name}/`,
      file_count: fileCount,
    });
  }

  if (relPaths.length === 0) {
    throw new Error("nothing selected to push");
  }

  // Pre-step ssh: resolve ~ in workdir, auto-install rsync if missing (same
  // pattern as ttyd/filebrowser/code-server), and create the context root
  // at mode 700. All diagnostics go to stderr so the BOTDOCK_CONTEXT_BASE
  // marker on stdout stays easy to parse. Writes to stderr are echoed back
  // on errors for the UI to show.
  const prep = buildPrepScript(session.workdir);
  // Bumped from 30s → 180s: apt-get install rsync on a slow mirror can
  // easily exceed 30s. When rsync is already present this just returns
  // immediately, so the higher ceiling only costs us on first push per
  // machine.
  const prepRes = sshExec(dir, machine, "bash -s", prep, 180_000);
  if (prepRes.code !== 0) {
    const hint = prepRes.stderr.includes("passwordless sudo unavailable")
      ? ` — configure passwordless sudo for rsync install, or run \`apt install rsync\` (or equivalent) on "${machine.name}" once.`
      : "";
    throw new Error(
      `remote prep failed on "${machine.name}" (ssh exit ${prepRes.code}): ${prepRes.stderr.trim() || prepRes.stdout.trim()}${hint}`,
    );
  }
  const marker = "BOTDOCK_CONTEXT_BASE:";
  const line = prepRes.stdout.split("\n").find((l) => l.startsWith(marker));
  if (!line) {
    throw new Error("remote prep didn't return a base path");
  }
  const remoteBase = line.slice(marker.length).trim();

  // Drop the list into a temp file and feed rsync via --files-from so we
  // don't blow through argv limits with a big bundle. Paths are relative
  // to dir.root; rsync materialises them under remoteBase preserving
  // directory structure.
  const staging = mkdtempSync(join(tmpdir(), "botdock-rsync-"));
  const listPath = join(staging, "files.list");
  writeFileSync(listPath, relPaths.join("\n") + "\n");

  const cfg = buildSshConfig(dir, machine);
  try {
    const args = [
      "-a",
      "--files-from", listPath,
      // Ensure the context_push event below is accurate — --stats would
      // be nice but we only consume exit code. Quiet otherwise to avoid
      // a flood of filenames in server logs.
      "--quiet",
      "-e", `ssh -F ${cfg.configPath}`,
      `${dir.root}/`,
      `${cfg.targetAlias}:${remoteBase}/`,
    ];
    const res = spawnSync("rsync", args, { encoding: "utf8", timeout: 600_000 });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(
          "rsync isn't installed on the BotDock host — install it (e.g. `apt install rsync`) and retry.",
        );
      }
      throw res.error;
    }
    if ((res.status ?? -1) !== 0) {
      const stderrTrim = (res.stderr ?? "").trim();
      // rsync exit 12 = protocol error, usually "rsync: not found" on the
      // remote. Surface a friendlier hint in that case.
      if (res.status === 12 && /(not found|command not found)/i.test(stderrTrim)) {
        throw new Error(
          `rsync isn't installed on the remote machine "${machine.name}" — install it there and retry.`,
        );
      }
      const msg = stderrTrim || (res.stdout ?? "").trim() || `rsync exited ${res.status}`;
      throw new Error(`rsync failed: ${msg}`);
    }
  } finally {
    cfg.dispose();
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  appendEvent(dir, sessionId, {
    ts: new Date().toISOString(),
    kind: "context_push",
    remote_base: remoteBase,
    transport: "rsync",
    items: pushed,
  });

  return { pushed, remote_base: remoteBase, transferred_files: relPaths.length };
}

/**
 * Build the bash prep script that runs on the remote before rsync. Does:
 *   1. Resolves ~ in workdir to $HOME.
 *   2. Ensures rsync is installed — detects the package manager and auto-
 *      installs if missing (apt/dnf/yum/apk/brew), using sudo -n when not
 *      root. Mirrors the ttyd/filebrowser/code-server install idiom.
 *   3. Creates `<workdir>/.botdock/context/` at mode 700.
 *   4. Prints `BOTDOCK_CONTEXT_BASE:<abspath>` on stdout for the caller.
 *
 * All user-facing diagnostics go to stderr so stdout is just the marker.
 * Any failure exits non-zero with a message the daemon surfaces verbatim.
 */
function buildPrepScript(workdir: string): string {
  return `
set -euo pipefail

# --- 1. ensure rsync is installed on the remote ---------------------------
ensure_rsync() {
  if command -v rsync >/dev/null 2>&1; then
    return 0
  fi

  # Resolve sudo strategy. Root needs no sudo; otherwise we require
  # passwordless sudo (-n) and bail early with a clear message if that's
  # not configured. Avoids hanging the ssh session on a password prompt.
  SUDO=""
  if [ "$(id -u)" != "0" ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      SUDO="sudo -n"
    else
      echo "rsync missing and passwordless sudo unavailable" >&2
      return 1
    fi
  fi

  echo "[botdock] rsync not found — installing via detected package manager…" >&2
  # Try each package manager in preference order. The update-then-install
  # apt form is split so an already-fresh cache doesn't double the latency.
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y rsync >&2 \\
      || { $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq >&2 \\
           && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y rsync >&2; }
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y rsync >&2
  elif command -v yum >/dev/null 2>&1; then
    $SUDO yum install -y rsync >&2
  elif command -v apk >/dev/null 2>&1; then
    $SUDO apk add --no-cache rsync >&2
  elif command -v pacman >/dev/null 2>&1; then
    $SUDO pacman -Sy --noconfirm rsync >&2
  elif command -v zypper >/dev/null 2>&1; then
    $SUDO zypper install -y rsync >&2
  elif command -v brew >/dev/null 2>&1; then
    # brew refuses to run as root; no sudo here regardless.
    brew install rsync >&2
  else
    echo "no known package manager (apt/dnf/yum/apk/pacman/zypper/brew) — install rsync manually" >&2
    return 1
  fi

  # Some package managers return 0 even when the target wasn't actually
  # installed (e.g. network hiccup on a proxy cache). Re-probe to catch
  # that before we return success.
  if ! command -v rsync >/dev/null 2>&1; then
    echo "package manager ran but rsync is still not on PATH" >&2
    return 1
  fi
  echo "[botdock] rsync installed." >&2
}

ensure_rsync

# --- 2. resolve workdir + create context root -----------------------------
WORKDIR=${shSingleQuote(workdir)}
case "$WORKDIR" in
  "~")   WORKDIR="$HOME" ;;
  "~/"*) WORKDIR="$HOME$(printf '%s' "$WORKDIR" | cut -c2-)" ;;
esac
BASE="$WORKDIR/.botdock/context"
mkdir -p "$BASE"
chmod 700 "$BASE" || true
echo "BOTDOCK_CONTEXT_BASE:$BASE"
`;
}

/** Yield absolute paths of every regular file under `root`. */
function* walkFiles(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) yield p;
    }
  }
}
