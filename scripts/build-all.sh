#!/usr/bin/env bash
# Cross-compile binaries for all supported platforms using Bun's --target.
# Output: dist-bin/botdock-<os>-<arch>
set -euo pipefail

cd "$(dirname "$0")/.."

TARGETS=(
  "bun-linux-x64:botdock-linux-x64"
  "bun-linux-arm64:botdock-linux-arm64"
  "bun-darwin-x64:botdock-darwin-x64"
  "bun-darwin-arm64:botdock-darwin-arm64"
  # Bun only ships a Windows x64 target — no arm64 yet (as of Bun 1.x).
  # Output keeps the .exe suffix so PE-aware tooling on Windows
  # (Explorer, AV, Tauri's externalBin matcher) treats it correctly.
  "bun-windows-x64:botdock-windows-x64.exe"
)

echo "[1/3] Installing deps (if needed)…"
bun install --frozen-lockfile 2>/dev/null || bun install

echo "[2/3] Building frontend…"
bun run web:build

echo "[3/3] Embedding frontend and compiling ${#TARGETS[@]} targets…"
bun scripts/embed-dist.ts

mkdir -p dist-bin

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  outname="${entry##*:}"
  echo "  → $outname ($target)"
  bun build \
    --compile \
    --minify \
    --target="$target" \
    --outfile "dist-bin/$outname" \
    src/cli.ts
done

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- src/server/embedded.ts 2>/dev/null || true
fi

echo ""
echo "Built:"
ls -lh dist-bin/botdock-* | awk '{print "  " $9 "  " $5}'
