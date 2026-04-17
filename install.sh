#!/usr/bin/env bash
# BotDock installer (install & upgrade in one).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
#   # or:
#   bash install.sh
#
# Env vars:
#   BOTDOCK_REPO         owner/repo on GitHub (default: baked-in)
#   BOTDOCK_INSTALL_DIR  where to drop the binary (default: $HOME/.botdock/bin)
#   BOTDOCK_VERSION      release tag to install (default: latest)

set -euo pipefail

REPO="${BOTDOCK_REPO:-camelop/dev.botdock.net}"
INSTALL_DIR="${BOTDOCK_INSTALL_DIR:-$HOME/.botdock/bin}"
REQUESTED_VERSION="${BOTDOCK_VERSION:-latest}"

info() { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mX\033[0m %s\n" "$*" >&2; exit 1; }

# --- detect platform -------------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
  linux)  OS_TAG="linux"  ;;
  darwin) OS_TAG="darwin" ;;
  *) die "unsupported OS: $OS (BotDock supports linux and darwin)" ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH_TAG="x64"   ;;
  aarch64|arm64) ARCH_TAG="arm64" ;;
  *) die "unsupported arch: $ARCH" ;;
esac
ASSET="botdock-${OS_TAG}-${ARCH_TAG}"

# --- resolve release -------------------------------------------------------
if [ "$REQUESTED_VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${REQUESTED_VERSION}/${ASSET}"
fi

# --- prereq checks ---------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need curl

# --- download atomically ---------------------------------------------------
info "Target: $ASSET ($REQUESTED_VERSION) from $REPO"
info "URL:    $URL"

mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/botdock"
TMP="$(mktemp "$INSTALL_DIR/.botdock.tmp.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

http_code=$(curl -fsSL -o "$TMP" -w '%{http_code}' "$URL" || true)
if [ "$http_code" != "200" ] || [ ! -s "$TMP" ]; then
  die "download failed (HTTP $http_code). Is the release published? See https://github.com/${REPO}/releases"
fi
chmod +x "$TMP"

# --- install / upgrade -----------------------------------------------------
if [ -e "$TARGET" ]; then
  OLD_VERSION=$("$TARGET" --version 2>/dev/null || echo "unknown")
  NEW_VERSION=$("$TMP" --version 2>/dev/null || echo "unknown")
  info "Upgrading: $OLD_VERSION → $NEW_VERSION"
else
  NEW_VERSION=$("$TMP" --version 2>/dev/null || echo "unknown")
  info "Installing: $NEW_VERSION"
fi
mv "$TMP" "$TARGET"
trap - EXIT

# --- PATH hint -------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    info "Installed: $TARGET"
    ;;
  *)
    info "Installed: $TARGET"
    warn "$INSTALL_DIR is not on your PATH."
    cat <<EOF

Add this to your shell rc (~/.bashrc, ~/.zshrc):

  export PATH="$INSTALL_DIR:\$PATH"

Then open a new terminal or run: source ~/.bashrc

EOF
    ;;
esac

# --- prereqs for runtime ---------------------------------------------------
missing=()
for bin in ssh ssh-keygen tmux; do
  command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
done
if [ "${#missing[@]}" -gt 0 ]; then
  warn "runtime tools missing: ${missing[*]}"
  warn "install them (e.g. apt-get install openssh-client tmux) before running 'botdock serve'."
fi

info "Done. Try:  botdock --version"
