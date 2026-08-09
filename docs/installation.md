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

Run init in an **empty folder** — cheasee-pi sets the workspace up itself:

1. Verifies Docker Engine 24.0+ is installed and running
2. Probes the folder — init is empty-folder-only (existing non-empty folders
   are refused; cheasee-pi never auto-initializes them)
3. Asks for your project repo URL (`owner/repo` or any GitHub URL)
4. Authenticates with GitHub (OAuth in browser)
5. Bare-clones your repo to `<parent>/.bare` and adds the main worktree into
   the folder
6. Scaffolds the dedicated `cheasee-settings.json` at the folder root
   (gitignored, machine-local — docker memory/cpus, git identity, default
   provider; never overwrites an existing file)

No docker files in your repo — the compose file and Dockerfile are CLI-managed
cache state, and pi's own `.pi/settings.json` is self-scaffolded by pi on its
first run.

{:.note-title}
> No GitHub?
> `cheasee-pi init --no-github` skips auth and the clone; you provide API keys
> separately. `--no-input` needs `--repo-url <url>` since there is no prompt.

### Add API keys later

```bash
cheasee-pi auth add opencode-go    # pick your provider
cheasee-pi auth list                # verify
```

## Run

Run cheasee-pi from your **cheasee-pi workspace** — or straight from an empty
folder, which auto-runs init first:

```bash
# ✓ Auth config saved to ~/.config/cheasee-pi/auth.json after init
cheasee-pi start
```

`cheasee-pi` (alias `start`) gates on the workspace state:

- **Empty folder** → auto-runs `cheasee-pi init` (repo URL prompt, bare clone
  + main worktree, `cheasee-settings.json`), then you run `start` again
- **`cheasee-settings.json` present** → initialized workspace; runs normally
- **Non-empty folder without `cheasee-settings.json`** → refused with
  “not initialized; run `cheasee-pi init` in an empty folder”

On an initialized workspace it:

1. Extracts compose/Dockerfile to the CLI cache dir
   (`~/.cache/cheasee-pi/<version>/`); the image build clones the cheasee-pi
   repo (Dockerfile `ARG CHEASEE_REF`, default `main`) into `/opt/cheasee-pi`
   and symlinks its resources into `~/.pi/agent/`
2. Starts the container (builds image ~2 min first time) with the workspace
   mounted at `/workspaces/main` and its sibling bare repo at
   `/workspaces/.bare` (the entrypoint rewrites worktree paths and locks them)
3. Injects keys from `~/.config/cheasee-pi/auth.json` and opens pi TUI

Pi auto-updates to the latest version on every container start. No manual update needed.

Stop the container when done:

```bash
cheasee-pi down
```

## After setup

Edit `cheasee-settings.json` in your workspace root to configure cheasee-pi:
`defaultProvider`, `docker.memory`/`docker.cpus`, `gitIdentity`.
Pi's own `.pi/settings.json` (`defaultModel`, `skills`, `prompts`, `extensions`,
`theme`) is self-scaffolded by pi on first run — the CLI never writes it.

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
