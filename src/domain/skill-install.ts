/**
 * Install / inspect the `botdock-context` Claude Agent Skill inside a
 * session's workdir. The skill itself lives on an orphan branch of the
 * main BotDock repo (https://github.com/camelop/dev.botdock.net, branch
 * `skill/botdock-context`) so distribution is just `git clone`.
 *
 * We leave the `.git` dir intact after install so later status checks can
 * compare local vs remote HEAD and offer an Update. For re-install / update,
 * we `git fetch && reset --hard` in place rather than rm-rf + re-clone
 * so any uncommitted local tweaks (rare, but possible if the user hand-
 * edits) are at least surfaced as a loss before they happen — git will
 * refuse `reset --hard` to go through if there's no branch conflict but
 * will absolutely clobber uncommitted changes. Callers should warn.
 */

import { DataDir } from "../storage/index.ts";
import { readMachine } from "./machines.ts";
import { readSession, appendEvent } from "./sessions.ts";
import { sshExec, shSingleQuote } from "../lib/remote.ts";

const SKILL_NAME = "botdock-context";
const SKILL_REPO_URL = "https://github.com/camelop/dev.botdock.net.git";
const SKILL_BRANCH = "skill/botdock-context";

export type SkillState =
  | "checking"
  | "not_installed"
  | "installed"
  | "update_available"
  | "error";

export type SkillStatus = {
  state: SkillState;
  local_sha?: string;        // HEAD of the installed copy, short form
  remote_sha?: string;       // tip of skill/botdock-context on origin
  target_path: string;       // absolute path where the skill lives / would live
  error?: string;            // populated when state === "error"
  /** Set when installed but the remote probe failed (offline machine /
   *  private GitHub). state stays "installed" in that case. */
  remote_unreachable?: boolean;
};

export type SkillInstallResult = {
  action: "installed" | "updated";
  local_sha: string;
  remote_sha?: string;
  target_path: string;
};

/**
 * Inspect the remote workdir and report the skill's state. Never
 * throws for normal "not installed" / "remote unreachable" cases —
 * those are reported via SkillStatus fields so the UI can branch.
 */
export async function getSkillStatus(
  dir: DataDir,
  sessionId: string,
): Promise<SkillStatus> {
  const session = readSession(dir, sessionId);
  const machine = readMachine(dir, session.machine);

  const script = `
set -uo pipefail
WORKDIR=${shSingleQuote(session.workdir)}
case "$WORKDIR" in
  "~")   WORKDIR="$HOME" ;;
  "~/"*) WORKDIR="$HOME$(printf '%s' "$WORKDIR" | cut -c2-)" ;;
esac
TARGET="$WORKDIR/.claude/skills/${SKILL_NAME}"
echo "TARGET:$TARGET"

if [ ! -f "$TARGET/SKILL.md" ]; then
  echo "STATE:not_installed"
  exit 0
fi

if [ ! -d "$TARGET/.git" ]; then
  # The SKILL.md is there but it's not a git checkout — treat as
  # installed without update detection (user may have unpacked it
  # manually). "installed" with empty local_sha signals that.
  echo "STATE:installed_no_git"
  echo "LOCAL_SHA:"
  exit 0
fi

LOCAL=$(git -C "$TARGET" rev-parse HEAD 2>/dev/null)
echo "LOCAL_SHA:\${LOCAL:-unknown}"

# Remote probe — tolerate failure. Short 10s timeout keeps the status
# check snappy even if the machine has flaky outbound access.
REMOTE=$(timeout 10 git ls-remote --heads ${shSingleQuote(SKILL_REPO_URL)} ${shSingleQuote(SKILL_BRANCH)} 2>/dev/null | awk '{print $1}')
if [ -z "$REMOTE" ]; then
  echo "STATE:installed"
  echo "REMOTE_UNREACHABLE:1"
  exit 0
fi
echo "REMOTE_SHA:$REMOTE"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "STATE:installed"
else
  echo "STATE:update_available"
fi
`;

  const res = sshExec(dir, machine, "bash -s", script, 30_000);
  if (res.code !== 0) {
    return {
      state: "error",
      target_path: "",
      error: (res.stderr || res.stdout).trim() || `ssh exit ${res.code}`,
    };
  }
  return parseStatus(res.stdout);
}

/**
 * Install the skill if absent, or update to the remote tip if a newer
 * commit is available. Both paths require `git` on the remote. Relies
 * on the machine being able to reach GitHub; offline machines need
 * a manual install.
 */
export async function installSkill(
  dir: DataDir,
  sessionId: string,
): Promise<SkillInstallResult> {
  const session = readSession(dir, sessionId);
  const machine = readMachine(dir, session.machine);

  const script = `
set -euo pipefail
WORKDIR=${shSingleQuote(session.workdir)}
case "$WORKDIR" in
  "~")   WORKDIR="$HOME" ;;
  "~/"*) WORKDIR="$HOME$(printf '%s' "$WORKDIR" | cut -c2-)" ;;
esac
TARGET="$WORKDIR/.claude/skills/${SKILL_NAME}"
PARENT=$(dirname "$TARGET")
mkdir -p "$PARENT"

if [ ! -x "$(command -v git)" ]; then
  echo "git is not installed on the remote — install it and retry" >&2
  exit 1
fi

if [ -d "$TARGET/.git" ]; then
  # Update in place. --depth 1 keeps the shallow history compact; we
  # explicitly re-shallow on each fetch to avoid unbounded growth.
  git -C "$TARGET" fetch --depth 1 origin ${shSingleQuote(SKILL_BRANCH)} >&2
  git -C "$TARGET" reset --hard FETCH_HEAD >&2
  git -C "$TARGET" clean -fd >&2
  ACTION="updated"
else
  # Fresh install. Clean any stale non-git dir the user might have had
  # from a manual install first, so the clone doesn't fail on a
  # non-empty target.
  if [ -e "$TARGET" ]; then
    rm -rf "$TARGET"
  fi
  git clone --depth 1 --branch ${shSingleQuote(SKILL_BRANCH)} \\
    ${shSingleQuote(SKILL_REPO_URL)} "$TARGET" >&2
  ACTION="installed"
fi

LOCAL=$(git -C "$TARGET" rev-parse HEAD)
REMOTE=$(timeout 10 git ls-remote --heads ${shSingleQuote(SKILL_REPO_URL)} ${shSingleQuote(SKILL_BRANCH)} 2>/dev/null | awk '{print $1}' || true)
echo "TARGET:$TARGET"
echo "ACTION:$ACTION"
echo "LOCAL_SHA:$LOCAL"
[ -n "$REMOTE" ] && echo "REMOTE_SHA:$REMOTE" || true
`;

  const res = sshExec(dir, machine, "bash -s", script, 120_000);
  if (res.code !== 0) {
    throw new Error(
      `skill install failed on "${machine.name}" (ssh exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  const lines = res.stdout.split("\n");
  const get = (prefix: string) => {
    const l = lines.find((x) => x.startsWith(prefix));
    return l ? l.slice(prefix.length).trim() : "";
  };
  const target = get("TARGET:");
  const action = get("ACTION:") as "installed" | "updated";
  const localSha = get("LOCAL_SHA:");
  const remoteSha = get("REMOTE_SHA:") || undefined;

  appendEvent(dir, sessionId, {
    ts: new Date().toISOString(),
    kind: "context_push",
    subject: "skill-install",
    action,
    target_path: target,
    local_sha: localSha,
    remote_sha: remoteSha,
  });

  return {
    action,
    local_sha: localSha,
    remote_sha: remoteSha,
    target_path: target,
  };
}

function parseStatus(stdout: string): SkillStatus {
  const lines = stdout.split("\n");
  const get = (prefix: string) => {
    const l = lines.find((x) => x.startsWith(prefix));
    return l ? l.slice(prefix.length).trim() : "";
  };
  const target = get("TARGET:");
  const rawState = get("STATE:");
  const local = get("LOCAL_SHA:") || undefined;
  const remote = get("REMOTE_SHA:") || undefined;
  const unreachable = get("REMOTE_UNREACHABLE:") === "1";

  // Normalise legacy "installed_no_git" to "installed" with the extra
  // flag so the UI can decide whether to offer a reinstall.
  const state: SkillState =
    rawState === "not_installed" ? "not_installed"
    : rawState === "update_available" ? "update_available"
    : rawState === "installed" || rawState === "installed_no_git" ? "installed"
    : "error";

  return {
    state,
    local_sha: local,
    remote_sha: remote,
    target_path: target,
    remote_unreachable: unreachable || undefined,
  };
}
