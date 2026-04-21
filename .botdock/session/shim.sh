#!/bin/sh
# Note: no "set -u" here on purpose. Sourcing a user's .bashrc / .zshrc with
# strict unbound-variable checking turned on routinely kills the shim \u2014 those
# files freely reference vars that may not be set in a non-interactive ssh
# shell.
DIR="$(cd "$(dirname "$0")" && pwd)"
EVENTS="$DIR/events.ndjson"
# Route shim's own stderr to a sibling file so even a very early crash leaves
# a trail we can surface back. tmux pipe-pane only captures pane output; this
# catches shell errors that happen before any command prints anything.
exec 2>>"$DIR/shim.stderr"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# First breadcrumb \u2014 if events.ndjson lacks this line, the shim never even ran.
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
#   SKIP_TRUST=1    (optional \u2014 folder-trust auto-accept)
#   RESUME_UUID=... (optional \u2014 resume an existing CC jsonl via --resume)
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
# do NOT pass --dangerously-skip-permissions \u2014 that also skips per-tool
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
  # Resuming an existing conversation. Any initial prompt is ignored \u2014
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
