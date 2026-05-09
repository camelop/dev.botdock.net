#!/usr/bin/env bash
# Copies the platform-matching BotDock CLI binaries from <repo>/dist-bin/
# into <desktop>/src-tauri/binaries/ with the target-triple naming Tauri's
# externalBin expects.
#
#   build:all output         →  Tauri sidecar name
#   ----------------------      --------------------------------------
#   botdock-linux-x64        →  botdock-x86_64-unknown-linux-gnu
#   botdock-linux-arm64      →  botdock-aarch64-unknown-linux-gnu
#   botdock-darwin-x64       →  botdock-x86_64-apple-darwin
#   botdock-darwin-arm64     →  botdock-aarch64-apple-darwin
#
# Run this before `tauri dev` / `tauri build` so the bundler picks them
# up — package.json's `dev` / `build` scripts already chain it in.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$HERE/.." && pwd)"
REPO_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
SRC_DIR="$REPO_DIR/dist-bin"
DST_DIR="$DESKTOP_DIR/src-tauri/binaries"
mkdir -p "$DST_DIR"

triple_for() {
  case "$1" in
    linux-x64)    echo x86_64-unknown-linux-gnu ;;
    linux-arm64)  echo aarch64-unknown-linux-gnu ;;
    darwin-x64)   echo x86_64-apple-darwin ;;
    darwin-arm64) echo aarch64-apple-darwin ;;
    *)            echo "" ;;
  esac
}

found_any=0
for short in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
  src="$SRC_DIR/botdock-$short"
  triple="$(triple_for "$short")"
  if [ -z "$triple" ]; then continue; fi
  dst="$DST_DIR/botdock-$triple"
  if [ -f "$src" ]; then
    cp -f "$src" "$dst"
    chmod +x "$dst"
    echo "[sidecar] $(basename "$src") -> $(basename "$dst")"
    found_any=1
  fi
done

if [ "$found_any" = "0" ]; then
  echo "[sidecar] no botdock-* binaries found under $SRC_DIR" >&2
  echo "[sidecar] run 'bun run build:all' (or 'bun run build' for host-only) from the repo root first" >&2
  exit 1
fi
