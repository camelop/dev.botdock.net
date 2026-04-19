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
  tmux_available: boolean;
  claude_available: boolean;
};

/** Read the ~/.botdock/installed.toml marker plus live tool availability. */
export function readInstalledState(dir: DataDir, machine: Machine): InstalledState {
  // Tiny script that emits key=value pairs — easier to parse than wrangling
  // a remote toml parser from shell. The availability check is deliberately
  // generous: a non-interactive ssh shell starts with a bare-bones PATH
  // (often just /bin:/usr/bin), so we extend with the usual user-local and
  // package-manager locations AND best-effort source the user's dotfiles.
  // Missing that sourcing was the root cause of the "why does it insist on
  // installing tmux when I already have tmux?" bug.
  const script = `
MARKER="$HOME/.botdock/installed.toml"
TTYD_PATH=""
TTYD_VERSION=""
TTYD_INSTALLED_AT=""
if [ -f "$MARKER" ]; then
  TTYD_PATH=$(awk -F ' = ' '/^ttyd_path/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  TTYD_VERSION=$(awk -F ' = ' '/^ttyd_version/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  TTYD_INSTALLED_AT=$(awk -F ' = ' '/^ttyd_installed_at/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
fi

# Collect every plausible PATH first. These won't cost us anything if a
# directory doesn't exist; exporting unreadable dirs is harmless.
for p in \\
  "$HOME/.botdock/bin" \\
  "$HOME/.local/bin" \\
  "$HOME/.bun/bin" \\
  "$HOME/.cargo/bin" \\
  "$HOME/bin" \\
  /usr/local/bin \\
  /usr/local/sbin \\
  /opt/homebrew/bin \\
  /opt/homebrew/sbin \\
  /home/linuxbrew/.linuxbrew/bin \\
  /home/linuxbrew/.linuxbrew/sbin \\
  /snap/bin; do
  case ":$PATH:" in *":$p:"*) ;; *) PATH="$p:$PATH" ;; esac
done
export PATH

# Also source the user's dotfiles — best-effort, never fatal. This picks
# up custom PATH additions (asdf, mise, conda, etc.) without us needing
# to know about each one.
for f in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$f" ] && . "$f" >/dev/null 2>&1 || true
done

TTYD_BIN=$(command -v ttyd 2>/dev/null || true)
TMUX_BIN=$(command -v tmux 2>/dev/null || true)
CLAUDE_BIN=$(command -v claude 2>/dev/null || true)

printf 'TTYD_PATH=%s\n'          "\${TTYD_PATH:-$TTYD_BIN}"
printf 'TTYD_VERSION=%s\n'       "$TTYD_VERSION"
printf 'TTYD_INSTALLED_AT=%s\n'  "$TTYD_INSTALLED_AT"
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
  const r = sshExec(dir, machine, "bash -s", script, 60_000);
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
  const r = sshExec(dir, machine, "bash -s", script, 90_000);
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

  // Write a tiny launcher script so tmux's command doesn't need nested
  // quoting. The launcher takes (port, inner_session_name) as $1 $2.
  //
  // Then `tmux new-session` can just invoke "$LAUNCHER $PORT $INNER" —
  // one level of quoting, no surprises. Also the launcher is `exec`-style
  // so the pane's PID is ttyd itself (useful for later ps-based probes).
  const script = `
set -euo pipefail
TMUX_NAME=${shQ(TERMINAL_TMUX_SESSION)}
INNER=${shQ(TERMINAL_DEFAULT_INNER)}
TTYD=${shQ(installed.ttyd!.path)}
LAUNCHER="$HOME/.botdock/bin/ttyd-launcher.sh"

mkdir -p "$HOME/.botdock/bin"
cat > "$LAUNCHER" <<'LAUNCH_EOF'
#!/bin/sh
exec "__TTYD_PATH__" -p "$1" -i 127.0.0.1 -W tmux new-session -A -s "$2"
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

tmux new-session -d -s "$TMUX_NAME" "$LAUNCHER $PORT $INNER"

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
  const r = sshExec(dir, machine, "bash -s", script, 30_000);
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

function shQ(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
