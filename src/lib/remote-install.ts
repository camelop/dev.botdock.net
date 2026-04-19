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
  // a remote toml parser from shell.
  const script = `
set -u
MARKER="$HOME/.botdock/installed.toml"
TTYD_PATH=""
TTYD_VERSION=""
TTYD_INSTALLED_AT=""
if [ -f "$MARKER" ]; then
  TTYD_PATH=$(awk -F ' = ' '/^ttyd_path/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  TTYD_VERSION=$(awk -F ' = ' '/^ttyd_version/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
  TTYD_INSTALLED_AT=$(awk -F ' = ' '/^ttyd_installed_at/ {gsub(/"/,"",$2); print $2; exit}' "$MARKER")
fi

export PATH="$HOME/.botdock/bin:$HOME/.local/bin:$PATH"
TTYD_BIN=$(command -v ttyd 2>/dev/null || true)
TMUX_BIN=$(command -v tmux 2>/dev/null || true)
CLAUDE_BIN=$(command -v claude 2>/dev/null || true)

printf 'TTYD_PATH=%s\n'          "\${TTYD_PATH:-$TTYD_BIN}"
printf 'TTYD_VERSION=%s\n'       "$TTYD_VERSION"
printf 'TTYD_INSTALLED_AT=%s\n'  "$TTYD_INSTALLED_AT"
printf 'TMUX_AVAILABLE=%s\n'     "$([ -n "$TMUX_BIN" ] && echo 1 || echo 0)"
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
  const installed = ensureTtyd(dir, machine);
  if (!installed.tmux_available) {
    throw new Error(
      "tmux not found on remote. Install it (apt install tmux / brew install tmux) before starting a terminal.",
    );
  }
  const script = `
set -euo pipefail
TMUX_NAME=${shQ(TERMINAL_TMUX_SESSION)}
INNER=${shQ(TERMINAL_DEFAULT_INNER)}
TTYD=${shQ(installed.ttyd!.path)}

# If our ttyd tmux session is already alive, discover its port from ps.
if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
  PORT=$(ps -o args= -u "$USER" 2>/dev/null | grep -F "$TTYD" | grep -v grep \
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

tmux new-session -d -s "$TMUX_NAME" \
  "$TTYD -p $PORT -i 127.0.0.1 -W tmux new-session -A -s \\"$INNER\\""
sleep 0.5
echo "BOTDOCK_TTYD_STARTED port=$PORT"
`;
  const r = sshExec(dir, machine, "bash -s", script, 30_000);
  if (r.code !== 0 || !/BOTDOCK_TTYD_(STARTED|ALREADY_RUNNING)/.test(r.stdout)) {
    throw new Error(`ttyd start failed: ${r.stderr.trim() || r.stdout.trim()}`);
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
