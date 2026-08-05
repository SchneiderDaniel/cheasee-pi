---
layout: default
title: Installation
nav_order: 2
---

# Installation

{: .no_toc }

## Prerequisites

- **Docker Engine** ≥24.0 with [Compose V2](https://docs.docker.com/compose/)
- **git** with `user.name` and `user.email` configured

## Install

### Linux / macOS

```bash
# Set version (check latest at https://github.com/SchneiderDaniel/cheasee-pi/releases)
VERSION="0.4"

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

1. Authenticates with GitHub (OAuth in browser)
2. Forks the repo (or use `--fork-url <URL>` / `--skip-fork`)
3. Clones your fork with a bare worktree
4. Extracts Docker config
5. Asks for provider API keys

{:.note-title}
> No GitHub?
> `cheasee-pi init --no-github` skips auth. You provide API keys separately.

### Add API keys later

```bash
cheasee-pi auth add opencode-go    # pick your provider
cheasee-pi auth list                # verify
```

## Run

```bash
# ✓ Auth config saved to ~/.config/cheasee-pi/auth.json after init
cheasee-pi
```

`cheasee-pi` starts the container (builds image ~2 min first time), injects keys
from `~/.config/cheasee-pi/auth.json`, and opens pi TUI.

Pi auto-updates to the latest version on every container start. No manual update needed.

Stop the container when done:

```bash
cheasee-pi down
```

Or use raw Docker:

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml down
```

## After setup

Update `.pi/settings.json` to point pi at your fork:

| Field | Change? | Description |
|-------|---------|-------------|
| `supervisor.repo` | **Yes** | Your fork (`YOU/cheasee-pi`) |
| `defaultProvider` | If needed | e.g. `"opencode-go"` |
| `defaultModel` | If needed | e.g. `"deepseek-v4-flash"` |

## What's next

- [Daily Usage](daily-usage.md) — parallel sessions, workflows, troubleshooting
- [Zed](https://zed.dev/) — recommend for the workspace: `zed .`

## Troubleshooting

### Container doesn't start

```bash
docker compose -f docker/docker-compose.yml build --no-cache
docker compose -f docker/docker-compose.yml up -d --build
```

### Permission errors

The compose file maps host UID/GID automatically. For manual commands:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f docker/docker-compose.yml up
```

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

Use `docker compose -f docker/docker-compose.yml up -d --build` (reads `~/.config/cheasee-pi/auth.json`). If you must use raw docker:

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
