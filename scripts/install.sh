#!/usr/bin/env bash
set -euo pipefail

# Cheasee-Pi installer — one line, any platform
# Usage: curl -fsL https://github.com/SchneiderDaniel/cheasee-pi/releases/latest/download/install.sh | bash

REPO="SchneiderDaniel/cheasee-pi"

# Detect latest version from GitHub API
echo "→ Detecting latest version…"
VERSION=$(curl -fsL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4 | sed 's/^v//')
echo "  Latest: v$VERSION"

# Detect OS and arch
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

# Map OS to archive name suffix
case "$OS" in
  linux|darwin)  SUFFIX="tar.gz" ;;
  mingw*|msys*|cygwin*) OS="windows"; SUFFIX="zip" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

ASSET="cheasee-pi_${VERSION}_${OS}_${ARCH}.${SUFFIX}"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/v${VERSION}/$ASSET"

echo "→ Downloading $ASSET…"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

curl -fsL "$DOWNLOAD_URL" -o "$TMPDIR/$ASSET"

if [ "$SUFFIX" = "zip" ]; then
  unzip -qo "$TMPDIR/$ASSET" -d "$TMPDIR"
else
  tar -xzf "$TMPDIR/$ASSET" -C "$TMPDIR"
fi

echo "→ Installing to /usr/local/bin/ (may need sudo)…"
if [ -w /usr/local/bin ]; then
  mv "$TMPDIR/cheasee-pi" /usr/local/bin/
else
  sudo mv "$TMPDIR/cheasee-pi" /usr/local/bin/
fi

chmod +x /usr/local/bin/cheasee-pi
echo "✓ Installed: $(cheasee-pi version)"
