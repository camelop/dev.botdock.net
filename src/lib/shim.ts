import type { AgentKind } from "../domain/sessions.ts";

/**
 * Remote shim for `generic-cmd`: single-shot command wrapper. Redirects
 * stdout/stderr into raw.log itself so tmux pipe-pane isn't needed — this
 * avoids the "shell echoes send-keys twice" class of bug entirely. When the
 * command exits, the pane exits and the tmux session ends.
 */
const GENERIC_CMD_SHIM = String.raw`#!/bin/sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
EVENTS="$DIR/events.ndjson"
RAW="$DIR/raw.log"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"started\",\"pid\":$$}" >> "$EVENTS"
sh "$DIR/cmd.sh" >"$RAW" 2>&1
EC=$?
printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"exited\",\"exit_code\":$EC}" >> "$EVENTS"
`;

/**
 * Remote shim for `claude-code`: keeps an interactive pane alive running
 * the `claude` CLI. Because claude needs a real TTY (it handles its own
 * rendering), we rely on `tmux pipe-pane` to mirror pane output to raw.log
 * instead of self-redirect. A small background helper waits for claude to
 * settle, then finds the jsonl it just opened under ~/.claude/projects/
 * and emits a `cc_session` event so the poller can store the transcript
 * path in session meta for later sync.
 */
const CLAUDE_CODE_SHIM = String.raw`#!/bin/sh
# Note: no "set -u" here on purpose. Sourcing a user's .bashrc / .zshrc with
# strict unbound-variable checking turned on routinely kills the shim — those
# files freely reference vars that may not be set in a non-interactive ssh
# shell.
DIR="$(cd "$(dirname "$0")" && pwd)"
EVENTS="$DIR/events.ndjson"
# Route shim's own stderr to a sibling file so even a very early crash leaves
# a trail we can surface back. tmux pipe-pane only captures pane output; this
# catches shell errors that happen before any command prints anything.
exec 2>>"$DIR/shim.stderr"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# First breadcrumb — if events.ndjson lacks this line, the shim never even ran.
printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"shim_boot\",\"agent\":\"claude-code\",\"pid\":$$}" >> "$EVENTS"

# ssh non-interactive shells often don't source ~/.bashrc or ~/.profile,
# which is where ~/.local/bin and similar get added to PATH. Prepend the
# usual suspects so the claude installer's symlink resolves.
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"

# Best-effort source of login-shell dotfiles for users who put installs
# under other prefixes. Errors here must not kill the shim.
for f in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$f" ]; then
    # shellcheck disable=SC1090
    . "$f" >/dev/null 2>&1 || true
  fi
done

if ! command -v claude >/dev/null 2>&1; then
  ESCAPED_PATH=$(printf '%s' "$PATH" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"failed_to_start\",\"error\":\"claude CLI not found\",\"path\":\"$ESCAPED_PATH\"}" >> "$EVENTS"
  exit 127
fi

CLAUDE_BIN=$(command -v claude)
ESCAPED_BIN=$(printf '%s' "$CLAUDE_BIN" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"pre_claude\",\"bin\":\"$ESCAPED_BIN\"}" >> "$EVENTS"

SESSION_EPOCH=$(date +%s)
printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"started\",\"pid\":$$,\"agent\":\"claude-code\"}" >> "$EVENTS"

# Background: wait a moment, then find the transcript jsonl that claude just
# opened. ~/.claude/projects/<dir-hash>/<uuid>.jsonl is the layout as of
# current claude-code versions; we filter by mtime > session start so we
# don't pick up an older session file.
(
  sleep 2
  FILE=$(find "$HOME/.claude/projects" -name '*.jsonl' -newermt "@$SESSION_EPOCH" 2>/dev/null \
         | head -1)
  if [ -n "$FILE" ]; then
    UUID=$(basename "$FILE" .jsonl)
    printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"cc_session\",\"file\":\"$FILE\",\"uuid\":\"$UUID\"}" >> "$EVENTS"
  fi
) &

# Run claude with the initial prompt (if provided). cmd.sh is sourced to
# pick up shell-quoted args; its content is a few assignments like:
#   PROMPT='...'
#   SKIP_TRUST=1    (optional — folder-trust auto-accept)
#   RESUME_UUID=... (optional — resume an existing CC jsonl via --resume)
# An empty PROMPT means launch claude interactively with no preloaded msg.
# RESUME_UUID takes precedence over PROMPT.
PROMPT=""
SKIP_TRUST=""
RESUME_UUID=""
# shellcheck disable=SC1091
. "$DIR/cmd.sh"

# Pre-accept claude's folder-trust prompt for this workdir. This writes
# projects.<cwd>.hasTrustDialogAccepted = true into ~/.claude.json so the
# "Is this a project you trust?" dialog doesn't appear. We intentionally
# do NOT pass --dangerously-skip-permissions — that also skips per-tool
# prompts, which the user may still want.
if [ -n "$SKIP_TRUST" ]; then
  CWD=$(pwd)
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$CWD" <<'__BOTDOCK_TRUST__' || true
import json, os, sys, tempfile
p = os.path.expanduser("~/.claude.json")
try:
    with open(p) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except Exception:
    sys.exit(0)  # don't risk corrupting an unparseable config
if not isinstance(cfg, dict):
    sys.exit(0)
projects = cfg.setdefault("projects", {})
if not isinstance(projects, dict):
    sys.exit(0)
entry = projects.setdefault(sys.argv[1], {})
if not isinstance(entry, dict):
    sys.exit(0)
entry["hasTrustDialogAccepted"] = True
fd, tmp = tempfile.mkstemp(prefix=".claude.", dir=os.path.dirname(p))
try:
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, p)
except Exception:
    try: os.unlink(tmp)
    except Exception: pass
    sys.exit(0)
__BOTDOCK_TRUST__
  fi
fi

if [ -n "$RESUME_UUID" ]; then
  # Resuming an existing conversation. Any initial prompt is ignored —
  # claude --resume picks up the transcript as-is. If the prior session's
  # jsonl is still held by a live claude process, claude will fork a new
  # branch; we warn the user in the UI before they hit Launch.
  claude --resume "$RESUME_UUID"
elif [ -n "$PROMPT" ]; then
  claude "$PROMPT"
else
  claude
fi
EC=$?
printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"exited\",\"exit_code\":$EC}" >> "$EVENTS"
`;

function shimFor(kind: AgentKind): string {
  switch (kind) {
    case "generic-cmd": return GENERIC_CMD_SHIM;
    case "claude-code": return CLAUDE_CODE_SHIM;
  }
}

/**
 * The cmd.sh content for each kind. For generic-cmd the user's script is
 * base64-encoded verbatim. For claude-code we wrap the prompt in a single
 * POSIX-quoted `PROMPT='...'` assignment so the shim can `. cmd.sh` safely.
 */
export function buildCmdB64(
  kind: AgentKind,
  cmd: string,
  opts?: { skipTrust?: boolean; resumeUuid?: string },
): string {
  const content = kind === "claude-code"
    ? `PROMPT=${shSingleQuote(cmd)}\n`
      + `SKIP_TRUST=${opts?.skipTrust ? "1" : ""}\n`
      + `RESUME_UUID=${shSingleQuote(opts?.resumeUuid ?? "")}\n`
    : cmd;
  return Buffer.from(content, "utf8").toString("base64");
}

function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Provisioning script uploaded over `ssh bash -s`. Lays down .botdock/
 * skeleton, writes shim.sh + cmd.sh, starts a detached tmux session.
 *
 * For claude-code we add `tmux pipe-pane` to capture the interactive
 * pane's output. Generic-cmd doesn't need pipe-pane because its shim
 * self-redirects into raw.log.
 */
export function provisioningScript(opts: {
  workdir: string;
  tmuxSession: string;
  cmdB64: string;
  agentKind: AgentKind;
}): string {
  const { workdir, tmuxSession, cmdB64, agentKind } = opts;
  const wq = shDouble(workdir);
  const tq = shDouble(tmuxSession);
  const shim = shimFor(agentKind);
  const pipePane = agentKind === "claude-code"
    ? `tmux pipe-pane -t "$TMUX_NAME" -o "cat >> $SDIR/raw.log"`
    : `# generic-cmd shim redirects to raw.log itself; pipe-pane skipped.`;

  return String.raw`#!/bin/bash
set -euo pipefail

WORKDIR="${wq}"
TMUX_NAME="${tq}"
CMD_B64="${cmdB64}"

case "$WORKDIR" in
  "~")   WORKDIR="$HOME" ;;
  "~/"*) WORKDIR="$HOME$(printf '%s' "$WORKDIR" | cut -c2-)" ;;
esac
mkdir -p "$WORKDIR"

SDIR="$WORKDIR/.botdock/session"
mkdir -p "$SDIR" \
  "$WORKDIR/.botdock/resources" \
  "$WORKDIR/.botdock/secrets" \
  "$WORKDIR/.botdock/tasks"

cat > "$SDIR/shim.sh" <<'__BOTDOCK_SHIM__'
${shim}__BOTDOCK_SHIM__

printf '%s' "$CMD_B64" | base64 -d > "$SDIR/cmd.sh"
chmod +x "$SDIR/shim.sh"
chmod +x "$SDIR/cmd.sh" 2>/dev/null || true

: > "$SDIR/raw.log"

if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux not installed on remote" >&2
  exit 127
fi

tmux new-session -d -s "$TMUX_NAME" -c "$WORKDIR" "$SDIR/shim.sh"
${pipePane}

echo "BOTDOCK_PROVISIONED"
`;
}

function shDouble(s: string): string {
  return s.replace(/(["\\$` ])/g, "\\$1");
}
