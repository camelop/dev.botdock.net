/**
 * Remote shim: pure-shell wrapper for a generic-cmd agent session.
 *
 * The shim is the tmux pane's first-and-only command — no interactive bash
 * sits between tmux and the user command. This avoids the classic
 * "send-keys + readline" race where the command line gets echoed twice into
 * the captured log (once raw before readline initializes, once after).
 *
 * Because the shim is the pane's command, we redirect the user command's
 * stdout/stderr into raw.log directly; pipe-pane is no longer needed.
 */
export const REMOTE_SHIM_SH = String.raw`#!/bin/sh
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
 * Provisioning script uploaded over `ssh bash -s`. Lays down .botdock/
 * skeleton, writes shim.sh + cmd.sh, starts a detached tmux session whose
 * pane runs the shim directly.
 */
export function provisioningScript(opts: {
  workdir: string;
  tmuxSession: string;
  cmdB64: string;
}): string {
  const { workdir, tmuxSession, cmdB64 } = opts;
  const wq = shDouble(workdir);
  const tq = shDouble(tmuxSession);
  return String.raw`#!/bin/bash
set -euo pipefail

WORKDIR="${wq}"
TMUX_NAME="${tq}"
CMD_B64="${cmdB64}"

# Expand a leading "~/" (or bare "~") against $HOME so the user can supply
# either an absolute path or a home-relative one.
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

# Shim: lifecycle events + stdout/stderr redirect.
cat > "$SDIR/shim.sh" <<'__BOTDOCK_SHIM__'
${REMOTE_SHIM_SH}__BOTDOCK_SHIM__

# User command (base64-encoded to sidestep all shell quoting).
printf '%s' "$CMD_B64" | base64 -d > "$SDIR/cmd.sh"
chmod +x "$SDIR/shim.sh" "$SDIR/cmd.sh"

# Pre-create raw.log so the poller can tail it without a race.
: > "$SDIR/raw.log"

# Require tmux on the remote.
if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux not installed on remote" >&2
  exit 127
fi

# Start the tmux session with the shim as the pane's initial (and only)
# command. When cmd.sh exits, shim exits, pane exits, session ends — that's
# how we detect "done".
tmux new-session -d -s "$TMUX_NAME" -c "$WORKDIR" "$SDIR/shim.sh"

echo "BOTDOCK_PROVISIONED"
`;
}

function shDouble(s: string): string {
  return s.replace(/(["\\$` ])/g, "\\$1");
}
