---
layout: default
title: Installation
nav_order: 2
---

# Installation

{: .no_toc }

1. TOC
{:toc}

## Prerequisites

- **Docker Engine** ≥24.0 with [Compose V2](https://docs.docker.com/compose/)
- **git** with `user.name` and `user.email` configured
- **Your own git repository** — cheasee-pi runs from any repo you own (it does not clone/fork anything)

## Install

### Linux / macOS

```bash
# Set version (check latest at https://github.com/SchneiderDaniel/cheasee-pi/releases)
VERSION="0.50"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in x86_64) ARCH="amd64" ;; aarch64|arm64) ARCH="arm64" ;; esac

# Download, extract, install
curl -fsL "https://github.com/SchneiderDaniel/cheasee-pi/releases/download/v${VERSION}/cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz" \
  | tar xz && sudo mv cheasee-pi /usr/local/bin/
```

{:.note-title}
> macOS
> Gatekeeper may block the unsigned binary. Run `xattr -d com.apple.quarantine /usr/local/bin/cheasee-pi` or Ctrl-click → Open in Finder.

### Windows

```powershell
# PowerShell
$version = "0.4"
$arch = if ((Get-CimInstance Win32_ComputerSystem).SystemType -match "ARM") { "arm64" } else { "amd64" }
curl -Lo cheasee-pi.zip "https://github.com/SchneiderDaniel/cheasee-pi/releases/download/v$version/cheasee-pi_${version}_windows_$arch.zip"
tar -xf cheasee-pi.zip
Move-Item cheasee-pi.exe "$env:LOCALAPPDATA\cheasee-pi\"
# Add to PATH manually: https://gist.github.com/nex3/c395b2f8fd4b020168be
```

### Verify

```bash
cheasee-pi --version
```

## Setup

```bash
cheasee-pi init
```

This one command handles everything:

1. Verifies Docker Engine 24.0+ is installed and running
2. Authenticates with GitHub (OAuth in browser)
3. Scaffolds `.pi/settings.json` into your repo with cheasee-pi defaults
   (absolute `/opt/cheasee-pi` resource paths; never overwrites an existing file)

No fork, no clone, no docker files in your repo — the compose file, Dockerfile,
and pi resources are CLI-managed cache state.

{:.note-title}
> No GitHub?
> `cheasee-pi init --no-github` skips auth. You provide API keys separately.

### Add API keys later

```bash
cheasee-pi auth add opencode-go    # pick your provider
cheasee-pi auth list                # verify
```

## Run

Run cheasee-pi from **your own git repository**:

```bash
# ✓ Auth config saved to ~/.config/cheasee-pi/auth.json after init
cheasee-pi
```

`cheasee-pi` (alias `start`):

1. Verifies the current directory is inside a git repository (refuses otherwise)
2. Scaffolds `.pi/settings.json` into the repo root if missing (never overwrites)
3. Extracts compose/Dockerfile/pi-resources to the CLI cache dir
   (`~/.cache/cheasee-pi/<version>/`)
4. Starts the container (builds image ~2 min first time) with your repo mounted
   at `/workspaces/main`
5. Injects keys from `~/.config/cheasee-pi/auth.json` and opens pi TUI

Pi auto-updates to the latest version on every container start. No manual update needed.

Stop the container when done:

```bash
cheasee-pi down
```

## After setup

Edit `.pi/settings.json` in your repo to configure pi: `defaultProvider`,
`defaultModel`, `docker.memory`/`docker.cpus`, `skills`, `prompts`,
`extensions`, `theme`. Delete the file and run `cheasee-pi start` to
re-scaffold defaults — the CLI never overwrites an existing file.

## What's next

- [Daily Usage](daily-usage.md) — parallel sessions, workflows, troubleshooting
- [Zed](https://zed.dev/) — recommend for the workspace: `zed .`

## Troubleshooting

### Container doesn't start

Compose/Dockerfile live in the CLI cache dir:

```bash
docker compose -f ~/.cache/cheasee-pi/<version>/docker-compose.yml build --no-cache
cheasee-pi start --build
```

### Permission errors

The entrypoint auto-detects host UID/GID from the `/workspaces/main` mount.
On macOS/Windows mounts with unusual ownership, pass them explicitly:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) \
  WORKSPACE_HOST_PATH=$(pwd) \
  docker compose -f ~/.cache/cheasee-pi/<version>/docker-compose.yml up
```

### macOS: repo outside Docker Desktop shared roots

Docker Desktop only shares `/Users`, `/Volumes`, `/private`, `/tmp`,
`/var/folders` by default. Repos elsewhere fail at mount time with "Mounts
denied" — move the repo under one of those roots or add it to Docker Desktop's
file-sharing settings.

### SELinux hosts (Fedora/RHEL)

Bind mounts are blocked without relabel labels. Set
`CHEASEEPI_SELINUX_RELABEL=1` when starting to append `:Z` to the mounts.

### Emoji not displaying

Install an emoji font on the host:

```bash
# Debian / Ubuntu
sudo apt install fonts-noto-color-emoji
# Fedora
sudo dnf install google-noto-color-emoji-fonts
# macOS / Windows — bundled, no action needed
```

For git branch icon (``), install a [Nerd Font](https://www.nerdfonts.com/):

```bash
wget -P /tmp https://github.com/ryanoasis/nerd-fonts/releases/download/v3.3.0/JetBrainsMono.zip
sudo unzip /tmp/JetBrainsMono.zip -d /usr/share/fonts/truetype/jetbrains-nerd
sudo fc-cache -fv
```

Then set the font in your terminal to `JetBrainsMono Nerd Font`.

### API keys not picked up

Use `cheasee-pi start` (reads `~/.config/cheasee-pi/auth.json`). If you must use raw docker:

```bash
docker exec -it \
  -e OPENCODE_API_KEY=$OPENCODE_API_KEY \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  --user agentuser -w /workspaces/main cheasee-pi pi
```

## Uninstall

```bash
sudo cheasee-pi uninstall
```

Add `--force` to skip confirmation, `--remove-git` to also delete `.git/`.

---

> Next: [Daily Usage guide](daily-usage.md)
