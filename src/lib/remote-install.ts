/**
 * Remote provisioning helpers: detect what's installed on a machine, and
 * install our prereqs (ttyd) into ~/.botdock/bin/ without sudo.
 *
 * A marker file at ~/.botdock/installed.toml on the remote records what we
 * put there, so subsequent runs can skip the download.
 */

import type { Machine } from "../domain/machines.ts";
import { DataDir } from "../storage/index.ts";
import { sshExec } from "./remote.ts";

export type RemotePlatform = {
  os: "linux" | "darwin" | "other";
  arch: "x86_64" | "aarch64" | "arm" | "other";
  raw_os: string;
  raw_arch: string;
};

export function detectPlatform(dir: DataDir, machine: Machine): RemotePlatform {
  const r = sshExec(dir, machine, "uname -s; uname -m", undefined, 10_000);
  if (r.code !== 0) throw new Error(`uname failed: ${r.stderr.trim()}`);
  const lines = r.stdout.split("\n").filter(Boolean);
  const rawOs = (lines[0] ?? "").trim();
  const rawArch = (lines[1] ?? "").trim();
  const os: RemotePlatform["os"] =
    rawOs === "Linux"  ? "linux" :
    rawOs === "Darwin" ? "darwin" : "other";
  const arch: RemotePlatform["arch"] =
    rawArch === "x86_64" || rawArch === "amd64" ? "x86_64" :
    rawArch === "aarch64" || rawArch === "arm64" ? "aarch64" :
    rawArch.startsWith("arm") ? "arm" : "other";
  return { os, arch, raw_os: rawOs, raw_arch: rawArch };
}

export type InstalledState = {
  ttyd?: { path: string; version?: string; installed_at: string };
  filebrowser?: { path: string; version?: string; installed_at: string };
  tmux_available: boolean;
  claude_available: boolean;
};

/** Read the ~/.botdock/installed.toml marker plus live tool availability. */
export function readInstalledState(dir: DataDir, machine: Machine): InstalledState {
  const script = `
MARKER="$HOME/.botdock/installed.toml"
TTYD_PATH=""
TTYD_VERSION=""
TTYD_INSTALLED_AT=""
FB_PATH=""
FB_VERSION=""
FB_INSTALLED_AT=""
if [ -f "$MARKER" ]; then
  TTYD_PATH=$(awk -F ' = ' '/^ttyd_path/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  TTYD_VERSION=$(awk -F ' = ' '/^ttyd_version/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  TTYD_INSTALLED_AT=$(awk -F ' = ' '/^ttyd_installed_at/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  FB_PATH=$(awk -F ' = ' '/^filebrowser_path/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  FB_VERSION=$(awk -F ' = ' '/^filebrowser_version/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  FB_INSTALLED_AT=$(awk -F ' = ' '/^filebrowser_installed_at/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
fi

# Look up each tool. which searches PATH; whereis looks in standard system
# locations regardless of PATH (covers the "ssh shell has a minimal PATH
# but the binary is installed at /usr/bin" case).
find_bin() {
  which "$1" 2>/dev/null || whereis -b "$1" 2>/dev/null | awk '/:/ {print $2}'
}
TTYD_BIN=$(find_bin ttyd)
TMUX_BIN=$(find_bin tmux)
CLAUDE_BIN=$(find_bin claude)
FB_BIN=$(find_bin filebrowser)

printf 'TTYD_PATH=%s\n'          "\${TTYD_PATH:-$TTYD_BIN}"
printf 'TTYD_VERSION=%s\n'       "$TTYD_VERSION"
printf 'TTYD_INSTALLED_AT=%s\n'  "$TTYD_INSTALLED_AT"
printf 'FB_PATH=%s\n'            "\${FB_PATH:-$FB_BIN}"
printf 'FB_VERSION=%s\n'         "$FB_VERSION"
printf 'FB_INSTALLED_AT=%s\n'    "$FB_INSTALLED_AT"
printf 'TMUX_BIN=%s\n'           "$TMUX_BIN"
printf 'TMUX_AVAILABLE=%s\n'     "$([ -n "$TMUX_BIN" ] && echo 1 || echo 0)"
printf 'CLAUDE_BIN=%s\n'         "$CLAUDE_BIN"
printf 'CLAUDE_AVAILABLE=%s\n'   "$([ -n "$CLAUDE_BIN" ] && echo 1 || echo 0)"
`;
  const r = sshExec(dir, machine, "bash -s", script, 10_000);
  if (r.code !== 0) throw new Error(`installed-check failed: ${r.stderr.trim()}`);
  const lines = Object.fromEntries(
    r.stdout.split("\n")
      .filter((l) => l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
  const ttydPath = (lines.TTYD_PATH ?? "").trim();
  const state: InstalledState = {
    tmux_available: lines.TMUX_AVAILABLE === "1",
    claude_available: lines.CLAUDE_AVAILABLE === "1",
  };
  if (ttydPath) {
    state.ttyd = {
      path: ttydPath,
      version: lines.TTYD_VERSION?.trim() || undefined,
      installed_at: lines.TTYD_INSTALLED_AT?.trim() || "",
    };
  }
  const fbPath = (lines.FB_PATH ?? "").trim();
  if (fbPath) {
    state.filebrowser = {
      path: fbPath,
      version: lines.FB_VERSION?.trim() || undefined,
      installed_at: lines.FB_INSTALLED_AT?.trim() || "",
    };
  }
  return state;
}

const TTYD_VERSION = "1.7.7";
function ttydAssetFor(platform: RemotePlatform): string | null {
  if (platform.os !== "linux") return null; // macOS: brew install ttyd; no static release
  if (platform.arch === "x86_64")  return `ttyd.x86_64`;
  if (platform.arch === "aarch64") return `ttyd.aarch64`;
  if (platform.arch === "arm")     return `ttyd.arm`;
  return null;
}

/**
 * Download the matching ttyd binary into ~/.botdock/bin/ttyd on the remote,
 * chmod +x, and update the installed.toml marker. Returns the new state.
 */
export function installTtyd(dir: DataDir, machine: Machine): InstalledState {
  const platform = detectPlatform(dir, machine);
  const asset = ttydAssetFor(platform);
  if (!asset) {
    throw new Error(
      `no prebuilt ttyd for ${platform.raw_os}/${platform.raw_arch}. ` +
      `On macOS: \`brew install ttyd\`. On Linux, install via your package manager.`,
    );
  }
  const url = `https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${asset}`;
  const nowIso = new Date().toISOString();
  const script = `
set -euo pipefail
mkdir -p "$HOME/.botdock/bin"
TMP=$(mktemp)
if command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$TMP" ${shQ(url)}
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" ${shQ(url)}
else
  echo "neither curl nor wget available on remote" >&2; exit 127
fi
chmod +x "$TMP"
mv "$TMP" "$HOME/.botdock/bin/ttyd"

# Marker file. Keep it minimal; future fields can accumulate here.
cat > "$HOME/.botdock/installed.toml" <<MARKER
ttyd_path = "$HOME/.botdock/bin/ttyd"
ttyd_version = "${TTYD_VERSION}"
ttyd_installed_at = "${nowIso}"
MARKER
echo "BOTDOCK_TTYD_INSTALLED"
`;
  const r = sshExec(dir, machine, "bash -s", script, 60_000, { noControlMaster: true });
  if (r.code !== 0 || !r.stdout.includes("BOTDOCK_TTYD_INSTALLED")) {
    throw new Error(`ttyd install failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return readInstalledState(dir, machine);
}

export function ensureTtyd(dir: DataDir, machine: Machine): InstalledState {
  const state = readInstalledState(dir, machine);
  if (state.ttyd?.path) return state;
  return installTtyd(dir, machine);
}

/**
 * Best-effort tmux install. Tries apt-get on Debian/Ubuntu boxes with
 * passwordless sudo; if that fails we surface a clear error telling the
 * user the one-liner they'd need to run themselves.
 *
 * We don't install tmux from source / binary because tmux has a runtime
 * dep on libevent + ncurses and distro-provided packages are way more
 * reliable than carrying our own.
 */
export function installTmux(dir: DataDir, machine: Machine): InstalledState {
  const platform = detectPlatform(dir, machine);
  if (platform.os !== "linux") {
    throw new Error(
      `tmux auto-install only supported on Linux right now. ` +
      `On macOS: \`brew install tmux\`.`,
    );
  }
  const script = `
set -u
if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get not found; BotDock only auto-installs tmux via apt for now." >&2
  echo "Install it yourself: e.g. dnf install tmux / pacman -S tmux / apk add tmux." >&2
  exit 127
fi

# Use -n so sudo fails fast instead of waiting for a password.
if ! sudo -n true 2>/dev/null; then
  if [ "$(id -u)" = "0" ]; then
    : # already root, sudo not needed
    APT() { apt-get "$@"; }
  else
    echo "tmux install needs sudo, but \\\`sudo -n true\\\` failed. Either:" >&2
    echo "  - configure passwordless sudo for this user, or" >&2
    echo "  - run on the remote:  sudo apt-get install -y tmux" >&2
    exit 126
  fi
else
  APT() { sudo -n apt-get "$@"; }
fi

DEBIAN_FRONTEND=noninteractive APT update -qq >/dev/null 2>&1 || true
DEBIAN_FRONTEND=noninteractive APT install -y tmux
echo "BOTDOCK_TMUX_INSTALLED"
`;
  const r = sshExec(dir, machine, "bash -s", script, 90_000, { noControlMaster: true });
  if (r.code !== 0 || !r.stdout.includes("BOTDOCK_TMUX_INSTALLED")) {
    throw new Error(`tmux install failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  }
  return readInstalledState(dir, machine);
}

export function ensureTmux(dir: DataDir, machine: Machine): InstalledState {
  const state = readInstalledState(dir, machine);
  if (state.tmux_available) return state;
  return installTmux(dir, machine);
}

// ---------------------------------------------------------------------------
// Terminal session lifecycle (the tmux + ttyd pair per machine)
// ---------------------------------------------------------------------------

const TERMINAL_TMUX_SESSION = "botdock-ttyd";
const TERMINAL_DEFAULT_INNER = "botdock-default";

export type TerminalStartResult = {
  remote_port: number;
  installed: InstalledState;
};

/**
 * The URL base-path ttyd is told to serve under. Must match the BotDock web
 * server route that proxies to it — browsers loading ttyd's HTML will
 * request JS/CSS and open the WebSocket under this prefix.
 */
export function terminalBasePath(machineName: string): string {
  return `/api/machines/${encodeURIComponent(machineName)}/terminal`;
}

/**
 * Idempotently ensure the per-machine terminal tmux + ttyd is up.
 * Allocates a high port on the remote (60000-60999) if a fresh spawn is
 * needed; reuses the existing port if our tmux session is already running.
 */
export function startTerminal(dir: DataDir, machine: Machine): TerminalStartResult {
  // Ensure tmux first (it's a harder install — apt + sudo), then ttyd.
  let installed = ensureTmux(dir, machine);
  installed = ensureTtyd(dir, machine);
  if (!installed.tmux_available) {
    throw new Error(
      "tmux still not available after install attempt. Check the output above " +
      "or install manually on the remote.",
    );
  }

  const basePath = terminalBasePath(machine.name);

  // Write a tiny launcher script so tmux's command doesn't need nested
  // quoting. The launcher takes (port, inner_session_name, base_path).
  //
  // --base-path tells ttyd to serve everything under BASE_PATH (so its
  // HTML, JS, CSS, and WebSocket endpoint all include the prefix). That
  // prefix matches the BotDock web server route that reverse-proxies to
  // this ttyd, making the whole thing accessible through the daemon's
  // own port without leaking the ad-hoc forward port to the browser.
  const script = `
set -euo pipefail
TMUX_NAME=${shQ(TERMINAL_TMUX_SESSION)}
INNER=${shQ(TERMINAL_DEFAULT_INNER)}
TTYD=${shQ(installed.ttyd!.path)}
BASE_PATH=${shQ(basePath)}
LAUNCHER="$HOME/.botdock/bin/ttyd-launcher.sh"

mkdir -p "$HOME/.botdock/bin"
cat > "$LAUNCHER" <<'LAUNCH_EOF'
#!/bin/sh
exec "__TTYD_PATH__" -p "$1" -i 127.0.0.1 -W --base-path "$3" tmux new-session -A -s "$2"
LAUNCH_EOF
# Replace the placeholder with the real ttyd path after the heredoc so we
# don't have to escape the path itself.
sed -i.bak "s|__TTYD_PATH__|$TTYD|" "$LAUNCHER" && rm -f "$LAUNCHER.bak"
chmod +x "$LAUNCHER"

# If our ttyd tmux session is already alive, discover its port from ps.
if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
  PORT=$(ps -o args= -u "$USER" 2>/dev/null | grep -F "$TTYD" | grep -v grep \\
         | grep -oE '(-p|--port)[[:space:]]+[0-9]+' | awk '{print $2}' | head -1)
  if [ -n "$PORT" ]; then
    echo "BOTDOCK_TTYD_ALREADY_RUNNING port=$PORT"
    exit 0
  fi
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
fi

# Pick a free port in the 60000-60999 range.
PORT=""
for p in $(seq 60000 60999); do
  if command -v ss >/dev/null 2>&1; then
    if ! ss -ltn 2>/dev/null | grep -q ":$p "; then PORT=$p; break; fi
  else
    if ! (bash -c "exec 3<>/dev/tcp/127.0.0.1/$p" 2>/dev/null); then PORT=$p; break; fi
  fi
done
if [ -z "$PORT" ]; then echo "no free port on remote" >&2; exit 1; fi

tmux new-session -d -s "$TMUX_NAME" "$LAUNCHER $PORT $INNER $BASE_PATH"

# Verify ttyd actually bound the port. Try up to ~3s before giving up —
# ttyd startup is fast but we want to rule out "pane died immediately".
ALIVE=0
for i in 1 2 3 4 5 6; do
  sleep 0.5
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -q ":$PORT "; then ALIVE=1; break; fi
  else
    if (bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT" 2>/dev/null); then ALIVE=1; break; fi
  fi
done
if [ "$ALIVE" != "1" ]; then
  # ttyd failed to bind. Capture the pane's output before tearing down so
  # the user can see what went wrong.
  PANE_OUT=$(tmux capture-pane -p -t "$TMUX_NAME" 2>/dev/null || true)
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
  echo "BOTDOCK_TTYD_FAILED port=$PORT" >&2
  echo "--- pane output ---" >&2
  printf '%s\\n' "$PANE_OUT" >&2
  exit 2
fi

echo "BOTDOCK_TTYD_STARTED port=$PORT"
`;
  const r = sshExec(dir, machine, "bash -s", script, 30_000, { noControlMaster: true });
  if (r.code !== 0 || !/BOTDOCK_TTYD_(STARTED|ALREADY_RUNNING)/.test(r.stdout)) {
    const detail = r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`;
    throw new Error(`ttyd start failed: ${detail}`);
  }
  const m = /port=(\d+)/.exec(r.stdout);
  if (!m) throw new Error("could not parse ttyd port from remote output");
  return { remote_port: Number(m[1]), installed };
}

export function stopTerminal(dir: DataDir, machine: Machine): void {
  sshExec(dir, machine, "bash -s",
    `tmux kill-session -t ${shQ(TERMINAL_TMUX_SESSION)} 2>/dev/null; echo ok`,
    10_000);
}

/**
 * Spawn a dedicated ttyd attached to a specific tmux session (the one a
 * claude-code BotDock session is running in). Returns the remote port ttyd
 * is listening on. Idempotent: if a ttyd for this tmux-session is already
 * alive, returns the existing port.
 *
 * Each BotDock session gets its own ttyd process wrapped in a supervisor
 * tmux session named `botdock-ttyd-<sid>`, so the main per-machine ttyd
 * stays free for interactive work.
 */
export function startSessionTerminal(
  dir: DataDir,
  machine: Machine,
  opts: { sessionId: string; tmuxSession: string; basePath: string },
): { remote_port: number; installed: InstalledState } {
  let installed = ensureTmux(dir, machine);
  installed = ensureTtyd(dir, machine);
  if (!installed.tmux_available) {
    throw new Error("tmux still not available after install attempt.");
  }
  const supervisorSession = `botdock-ttyd-${opts.sessionId}`;
  const script = `
set -euo pipefail
SUPER=${shQ(supervisorSession)}
TARGET_TMUX=${shQ(opts.tmuxSession)}
TTYD=${shQ(installed.ttyd!.path)}
BASE_PATH=${shQ(opts.basePath)}
LAUNCHER="$HOME/.botdock/bin/ttyd-attach-launcher.sh"

mkdir -p "$HOME/.botdock/bin"
cat > "$LAUNCHER" <<'LAUNCH_EOF'
#!/bin/sh
# $1 = port, $2 = target tmux session, $3 = base-path
exec "__TTYD_PATH__" -p "$1" -i 127.0.0.1 -W --base-path "$3" tmux attach -t "$2"
LAUNCH_EOF
sed -i.bak "s|__TTYD_PATH__|$TTYD|" "$LAUNCHER" && rm -f "$LAUNCHER.bak"
chmod +x "$LAUNCHER"

if tmux has-session -t "$SUPER" 2>/dev/null; then
  PORT=$(ps -o args= -u "$USER" 2>/dev/null | grep -F "$TTYD" | grep -F "$BASE_PATH" | grep -v grep \\
         | grep -oE '(-p|--port)[[:space:]]+[0-9]+' | awk '{print $2}' | head -1)
  if [ -n "$PORT" ]; then
    echo "BOTDOCK_SESSION_TTYD_ALREADY_RUNNING port=$PORT"
    exit 0
  fi
  tmux kill-session -t "$SUPER" 2>/dev/null || true
fi

PORT=""
for p in $(seq 60000 60999); do
  if command -v ss >/dev/null 2>&1; then
    if ! ss -ltn 2>/dev/null | grep -q ":$p "; then PORT=$p; break; fi
  else
    if ! (bash -c "exec 3<>/dev/tcp/127.0.0.1/$p" 2>/dev/null); then PORT=$p; break; fi
  fi
done
if [ -z "$PORT" ]; then echo "no free port on remote" >&2; exit 1; fi

tmux new-session -d -s "$SUPER" "$LAUNCHER $PORT $TARGET_TMUX $BASE_PATH"

ALIVE=0
for i in 1 2 3 4 5 6; do
  sleep 0.5
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -q ":$PORT "; then ALIVE=1; break; fi
  else
    if (bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT" 2>/dev/null); then ALIVE=1; break; fi
  fi
done
if [ "$ALIVE" != "1" ]; then
  PANE_OUT=$(tmux capture-pane -p -t "$SUPER" 2>/dev/null || true)
  tmux kill-session -t "$SUPER" 2>/dev/null || true
  echo "BOTDOCK_SESSION_TTYD_FAILED port=$PORT" >&2
  echo "--- pane output ---" >&2
  printf '%s\\n' "$PANE_OUT" >&2
  exit 2
fi

echo "BOTDOCK_SESSION_TTYD_STARTED port=$PORT"
`;
  const r = sshExec(dir, machine, "bash -s", script, 30_000, { noControlMaster: true });
  if (r.code !== 0 || !/BOTDOCK_SESSION_TTYD_(STARTED|ALREADY_RUNNING)/.test(r.stdout)) {
    throw new Error(
      `session-ttyd start failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`,
    );
  }
  const m = /port=(\d+)/.exec(r.stdout);
  if (!m) throw new Error("could not parse session-ttyd port from remote output");
  return { remote_port: Number(m[1]), installed };
}

export function stopSessionTerminal(
  dir: DataDir,
  machine: Machine,
  sessionId: string,
): void {
  const supervisor = `botdock-ttyd-${sessionId}`;
  sshExec(dir, machine, "bash -s",
    `tmux kill-session -t ${shQ(supervisor)} 2>/dev/null; echo ok`,
    10_000);
}

export function sessionTerminalBasePath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/terminal`;
}

// --- filebrowser -----------------------------------------------------------

const FILEBROWSER_VERSION = "2.63.2";

function filebrowserAssetFor(platform: RemotePlatform): string | null {
  const arch = platform.arch === "x86_64"  ? "amd64"
             : platform.arch === "aarch64" ? "arm64"
             : null;
  if (!arch) return null;
  if (platform.os === "linux")  return `linux-${arch}-filebrowser.tar.gz`;
  if (platform.os === "darwin") return `darwin-${arch}-filebrowser.tar.gz`;
  return null;
}

/**
 * Download filebrowser into ~/.botdock/bin/filebrowser. Preserves the
 * existing ttyd fields in the marker file so neither install blows the
 * other one's record away.
 */
export function installFilebrowser(dir: DataDir, machine: Machine): InstalledState {
  const platform = detectPlatform(dir, machine);
  const asset = filebrowserAssetFor(platform);
  if (!asset) {
    throw new Error(
      `no prebuilt filebrowser for ${platform.raw_os}/${platform.raw_arch}.`,
    );
  }
  const url = `https://github.com/filebrowser/filebrowser/releases/download/v${FILEBROWSER_VERSION}/${asset}`;
  const nowIso = new Date().toISOString();
  const script = `
set -euo pipefail
mkdir -p "$HOME/.botdock/bin"
TMPDIR_FB=$(mktemp -d)
trap 'rm -rf "$TMPDIR_FB"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$TMPDIR_FB/fb.tgz" ${shQ(url)}
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMPDIR_FB/fb.tgz" ${shQ(url)}
else
  echo "neither curl nor wget available on remote" >&2; exit 127
fi
tar -C "$TMPDIR_FB" -xzf "$TMPDIR_FB/fb.tgz"
[ -f "$TMPDIR_FB/filebrowser" ] || { echo "tarball did not contain filebrowser binary" >&2; exit 1; }
chmod +x "$TMPDIR_FB/filebrowser"
mv -f "$TMPDIR_FB/filebrowser" "$HOME/.botdock/bin/filebrowser"

# Preserve any existing ttyd marker fields while writing filebrowser fields.
MARKER="$HOME/.botdock/installed.toml"
EXISTING_TTYD_PATH=""
EXISTING_TTYD_VERSION=""
EXISTING_TTYD_INSTALLED_AT=""
if [ -f "$MARKER" ]; then
  EXISTING_TTYD_PATH=$(awk -F ' = ' '/^ttyd_path/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  EXISTING_TTYD_VERSION=$(awk -F ' = ' '/^ttyd_version/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  EXISTING_TTYD_INSTALLED_AT=$(awk -F ' = ' '/^ttyd_installed_at/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
fi
cat > "$MARKER" <<MARKER
ttyd_path = "$EXISTING_TTYD_PATH"
ttyd_version = "$EXISTING_TTYD_VERSION"
ttyd_installed_at = "$EXISTING_TTYD_INSTALLED_AT"
filebrowser_path = "$HOME/.botdock/bin/filebrowser"
filebrowser_version = "${FILEBROWSER_VERSION}"
filebrowser_installed_at = "${nowIso}"
MARKER
echo "BOTDOCK_FB_INSTALLED"
`;
  const r = sshExec(dir, machine, "bash -s", script, 120_000, { noControlMaster: true });
  if (r.code !== 0 || !r.stdout.includes("BOTDOCK_FB_INSTALLED")) {
    throw new Error(`filebrowser install failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return readInstalledState(dir, machine);
}

export function ensureFilebrowser(dir: DataDir, machine: Machine): InstalledState {
  const state = readInstalledState(dir, machine);
  if (state.filebrowser?.path) return state;
  return installFilebrowser(dir, machine);
}

/**
 * Spawn a per-session filebrowser bound to the session's workdir, listening
 * on 127.0.0.1 on the remote. BotDock's `forward-manager` pairs it with an
 * ssh -L so the local side can reverse-proxy into it.
 *
 * Supervision: like ttyd, the binary runs inside a dedicated tmux session
 * named `botdock-fb-<sid>`. Auth method is "noauth" so the UI goes straight
 * to the file listing. The DB lives inside the session's `.botdock/`
 * directory so it's cleaned when the session is deleted.
 */
export function startSessionFilebrowser(
  dir: DataDir,
  machine: Machine,
  opts: { sessionId: string; workdir: string; basePath: string },
): { remote_port: number; installed: InstalledState } {
  let installed = ensureTmux(dir, machine);
  installed = ensureFilebrowser(dir, machine);
  if (!installed.tmux_available) {
    throw new Error("tmux still not available after install attempt.");
  }
  const supervisorSession = `botdock-fb-${opts.sessionId}`;
  const script = `
set -euo pipefail
SUPER=${shQ(supervisorSession)}
FB=${shQ(installed.filebrowser!.path)}
BASE_PATH=${shQ(opts.basePath)}
WORKDIR=${shQ(opts.workdir)}

case "$WORKDIR" in
  "~")   WORKDIR="$HOME" ;;
  "~/"*) WORKDIR="$HOME$(printf '%s' "$WORKDIR" | cut -c2-)" ;;
esac
mkdir -p "$WORKDIR/.botdock/session"
DB="$WORKDIR/.botdock/session/filebrowser.db"

# Reuse an already-running supervisor if it's still up for this session —
# idempotent Start call from the UI should be cheap.
if tmux has-session -t "$SUPER" 2>/dev/null; then
  PORT=$(ps -o args= -u "$USER" 2>/dev/null | grep -F "$FB" | grep -F "$DB" | grep -v grep \\
         | grep -oE '(-p|--port)[[:space:]]+[0-9]+' | awk '{print $2}' | head -1)
  if [ -n "$PORT" ]; then
    echo "BOTDOCK_SESSION_FB_ALREADY_RUNNING port=$PORT"
    exit 0
  fi
  tmux kill-session -t "$SUPER" 2>/dev/null || true
fi

# Initialize the DB the first time we see this session. noauth + a single
# admin user whose password is never used (strength check only). The perms
# default to full read/write — BotDock is a single-user local tool, so
# locking this down further is not worthwhile.
if [ ! -s "$DB" ]; then
  "$FB" config init -d "$DB" --auth.method=noauth -b "$BASE_PATH" --minimumPasswordLength 1 >/dev/null
  "$FB" users add admin 'Xq9!pr3zA#bL' -d "$DB" --perm.admin --scope . >/dev/null 2>&1 || true
else
  # Update baseURL on each start — a restarted BotDock may have different
  # mount path in dev; writing is cheap and keeps the DB in sync.
  "$FB" config set -d "$DB" -b "$BASE_PATH" >/dev/null 2>&1 || true
fi

PORT=""
for p in $(seq 61000 61999); do
  if command -v ss >/dev/null 2>&1; then
    if ! ss -ltn 2>/dev/null | grep -q ":$p "; then PORT=$p; break; fi
  else
    if ! (bash -c "exec 3<>/dev/tcp/127.0.0.1/$p" 2>/dev/null); then PORT=$p; break; fi
  fi
done
if [ -z "$PORT" ]; then echo "no free port on remote" >&2; exit 1; fi

tmux new-session -d -s "$SUPER" "$FB -d $DB -a 127.0.0.1 -p $PORT -r $WORKDIR"

ALIVE=0
for i in 1 2 3 4 5 6 7 8; do
  sleep 0.5
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -q ":$PORT "; then ALIVE=1; break; fi
  else
    if (bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT" 2>/dev/null); then ALIVE=1; break; fi
  fi
done
if [ "$ALIVE" != "1" ]; then
  PANE_OUT=$(tmux capture-pane -p -t "$SUPER" 2>/dev/null || true)
  tmux kill-session -t "$SUPER" 2>/dev/null || true
  echo "BOTDOCK_SESSION_FB_FAILED port=$PORT" >&2
  echo "--- pane output ---" >&2
  printf '%s\\n' "$PANE_OUT" >&2
  exit 2
fi

echo "BOTDOCK_SESSION_FB_STARTED port=$PORT"
`;
  const r = sshExec(dir, machine, "bash -s", script, 60_000, { noControlMaster: true });
  if (r.code !== 0 || !/BOTDOCK_SESSION_FB_(STARTED|ALREADY_RUNNING)/.test(r.stdout)) {
    throw new Error(
      `session-filebrowser start failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`,
    );
  }
  const m = /port=(\d+)/.exec(r.stdout);
  if (!m) throw new Error("could not parse session-filebrowser port from remote output");
  return { remote_port: Number(m[1]), installed };
}

export function stopSessionFilebrowser(
  dir: DataDir,
  machine: Machine,
  sessionId: string,
): void {
  const supervisor = `botdock-fb-${sessionId}`;
  sshExec(dir, machine, "bash -s",
    `tmux kill-session -t ${shQ(supervisor)} 2>/dev/null; echo ok`,
    10_000);
}

export function sessionFilebrowserBasePath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/files`;
}

function shQ(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
