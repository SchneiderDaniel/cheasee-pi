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

# Prefer /usr/local/bin (sudo if needed), fall back to ~/.local/bin
if [ -w /usr/local/bin ]; then
  DEST="/usr/local/bin"
  mv "$TMPDIR/cheasee-pi" "$DEST/"
elif command -v sudo &>/dev/null; then
  DEST="/usr/local/bin"
  sudo mv "$TMPDIR/cheasee-pi" "$DEST/"
else
  DEST="${HOME}/.local/bin"
  mkdir -p "$DEST"
  mv "$TMPDIR/cheasee-pi" "$DEST/"
  echo "  Installed to $DEST — ensure it's on your PATH"
fi

chmod +x "$DEST/cheasee-pi"
echo "✓ Installed: $DEST/cheasee-pi"
"$DEST/cheasee-pi" version

