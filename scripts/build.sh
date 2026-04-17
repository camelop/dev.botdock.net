#!/usr/bin/env bash
# Build a single-platform binary for the host machine.
# Output: dist-bin/botdock
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[1/4] Installing deps (if needed)…"
bun install --frozen-lockfile 2>/dev/null || bun install

echo "[2/4] Building frontend…"
bun run web:build

echo "[3/4] Embedding frontend into src/server/embedded.ts…"
bun scripts/embed-dist.ts

mkdir -p dist-bin

echo "[4/4] Compiling binary…"
bun build \
  --compile \
  --minify \
  --sourcemap \
  --outfile dist-bin/botdock \
  src/cli.ts

# Restore the embedded.ts stub so the working tree stays clean.
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- src/server/embedded.ts 2>/dev/null || true
fi

echo ""
echo "built dist-bin/botdock ($(du -h dist-bin/botdock | cut -f1))"
