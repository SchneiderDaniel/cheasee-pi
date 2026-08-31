#!/usr/bin/env bash
set -euo pipefail

# Cheasee-Pi installer — one line, any platform
# Usage: curl -fsL https://raw.githubusercontent.com/SchneiderDaniel/cheasee-pi/main/scripts/install.sh | bash

REPO="SchneiderDaniel/cheasee-pi"

# Prefer curl, fall back to wget
if command -v curl &>/dev/null; then
  fetch() { curl -fsL "$1" -o "$2"; }
  fetch_json() { curl -fsL "$1"; }
elif command -v wget &>/dev/null; then
  fetch() { wget -qO "$2" "$1"; }
  fetch_json() { wget -qO- "$1"; }
else
  echo "Need curl or wget to download." >&2
  exit 1
fi

# Detect latest version from GitHub API
echo "→ Detecting latest version…"
VERSION=$(fetch_json "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4 | sed 's/^v//')
echo "  Latest: v$VERSION"

# Detect OS and arch
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

# Map OS to archive name suffix
case "$OS" in
  linux|darwin)  SUFFIX="tar.gz" ;;
  mingw*|msys*|cygwin*) OS="windows"; SUFFIX="zip" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

ASSET="cheasee-pi_${VERSION}_${OS}_${ARCH}.${SUFFIX}"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/v${VERSION}/$ASSET"

echo "→ Downloading $ASSET…"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

fetch "$DOWNLOAD_URL" "$TMPDIR/$ASSET"

if [ "$SUFFIX" = "zip" ]; then
  command -v unzip &>/dev/null || { echo "Need unzip to extract." >&2; exit 1; }
  unzip -qo "$TMPDIR/$ASSET" -d "$TMPDIR"
else
  tar -xzf "$TMPDIR/$ASSET" -C "$TMPDIR"
fi

# Single canonical location: ~/.local/bin — no sudo, no /usr/local/bin
# branch. Two possible homes caused stale-copy shadowing: an install or
# uninstall run from one PATH position left the sibling binary behind, and
# the leftover copy won every bare `cheasee-pi` call (e.g. a pre-v0.55.3
# binary shadowing a fresh install). A legacy /usr/local/bin copy is swept
# best-effort, keeping the invariant: at most one cheasee-pi binary on PATH.
DEST="${HOME}/.local/bin"
mkdir -p "$DEST"
mv "$TMPDIR/cheasee-pi" "$DEST/"
if [ -e /usr/local/bin/cheasee-pi ]; then
  if rm -f /usr/local/bin/cheasee-pi 2>/dev/null; then
    echo "  ✓ Removed legacy copy /usr/local/bin/cheasee-pi (single-location policy)"
  else
    echo "  ⚠ Legacy copy still at /usr/local/bin/cheasee-pi — remove manually: sudo rm /usr/local/bin/cheasee-pi" >&2
  fi
fi

chmod +x "$DEST/cheasee-pi"
echo "✓ Installed: $DEST/cheasee-pi"
"$DEST/cheasee-pi" --version

