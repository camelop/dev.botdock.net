/**
 * Remote shim: a pure-shell wrapper we write to `<workdir>/.botdock/session/shim.sh`.
 * tmux pipe-pane captures the pane output separately; this script only tracks
 * lifecycle events (started / exited).
 */
export const REMOTE_SHIM_SH = String.raw`#!/bin/sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
EVENTS="$DIR/events.ndjson"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"started\",\"pid\":$$}" >> "$EVENTS"
sh "$DIR/cmd.sh"
EC=$?
printf '%s\n' "{\"ts\":\"$(ts)\",\"kind\":\"exited\",\"exit_code\":$EC}" >> "$EVENTS"
`;

/**
 * Build the provisioning bash script that runs on the remote over ssh stdin.
 * Stdin: a bash script that receives workdir, tmux session name, base64-encoded
 * user command, and lays down the `.botdock/session/` skeleton + tmux session.
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

SDIR="$WORKDIR/.botdock/session"
mkdir -p "$SDIR" \
  "$WORKDIR/.botdock/resources" \
  "$WORKDIR/.botdock/secrets" \
  "$WORKDIR/.botdock/tasks"

# Shim: lifecycle events only. pipe-pane captures raw output separately.
cat > "$SDIR/shim.sh" <<'__BOTDOCK_SHIM__'
${REMOTE_SHIM_SH}__BOTDOCK_SHIM__

# User command (base64-encoded to sidestep all shell quoting).
printf '%s' "$CMD_B64" | base64 -d > "$SDIR/cmd.sh"
chmod +x "$SDIR/shim.sh" "$SDIR/cmd.sh"

# Make sure the raw log file exists before pipe-pane attaches.
: > "$SDIR/raw.log"

# Ensure tmux is available.
if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux not installed on remote" >&2
  exit 127
fi

# Launch detached. Start a plain shell in the workdir, then pipe-pane, then send
# the shim as the first command so its full output lands in the raw log.
tmux new-session -d -s "$TMUX_NAME" -c "$WORKDIR"
tmux pipe-pane -t "$TMUX_NAME" -o "cat >> $SDIR/raw.log"
tmux send-keys -t "$TMUX_NAME" "$SDIR/shim.sh; exit" Enter

echo "BOTDOCK_PROVISIONED"
`;
}

function shDouble(s: string): string {
  return s.replace(/(["\\$` ])/g, "\\$1");
}
