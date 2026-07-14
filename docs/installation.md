---
layout: default
title: Installation
nav_order: 2
---

# Installation

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Prerequisites

**Dependencies:** [Docker Engine](https://docs.docker.com/engine/install/) ≥24.0 with Compose V2 + [git](https://git-scm.com/).

Git identity is required so the supervisor extension can commit changes inside the
container. The host's `git config user.name` and `git config user.email` are passed
into the container automatically by the setup scripts. If unset on the host, the
container defaults to `Cheasee-Pi <cheasee-pi@localhost>`.

**Emoji font (optional, recommended):** The `context-info` extension and various
TUI components display emoji icons (🧠, 🔧, 🔒, 📦, ⏱). The container image
includes `fonts-noto-color-emoji`, but the host terminal emulator must also
possess an emoji-capable font for glyph rendering. Most desktop environments
ship one by default (Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji).
If emoji appear as empty boxes (`□`, `▯`) when running the Pi TUI, install
an emoji font on the host:

```bash
# Debian / Ubuntu host
sudo apt install fonts-noto-color-emoji

# Fedora / RHEL
sudo dnf install google-noto-color-emoji-fonts

# macOS / Windows — fonts are bundled; no action required
```

See the [Troubleshooting](#emoji-icons-not-displaying) section if icons still
don't render after installation.

---

> **Two paths available.** Pick the one that fits your setup:
>
> - **Go CLI Path (Recommended)** — Static binary, one `init` command replaces manual
>   fork/clone/submodule/extract. ~15–30 MB download vs ~500 MB clone. No Go toolchain
>   required. Supports **Linux** and **macOS** (Intel + Apple Silicon).
> - **Legacy Bash Path** — The original 8-step `./cheasee-pi.sh` workflow. Works on any
>   system with bash + Docker, including **Windows via WSL2**. No Go binary needed.

---

## Go CLI Path (Recommended) {: #go-cli-path }

**Best for new users.** Download a statically linked binary from GitHub Releases and run
`cheasee-pi init` to set up your fork, clone, submodule, and Docker configuration in a
single interactive command.

**Supported platforms:** Linux (amd64, arm64) and macOS (amd64, arm64). Windows users
should follow the [Legacy Bash Path](#legacy-bash-path) via WSL2.

> **Size:** The Go binary is ~15–30 MB. Compare to a full repo clone at ~500 MB
> (includes node_modules, test fixtures, images) — a 15–30× bandwidth saving.

### Step 1: Download the binary

Visit the [GitHub Releases page](https://github.com/SchneiderDaniel/cheasee-pi/releases)
and download the archive matching your OS and architecture.

Or use the terminal to detect your platform and download automatically:

```bash
# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Map uname arch to GoReleaser arch names
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  arm64)   ARCH="arm64" ;;
esac

# Download the latest release archive
VERSION="0.1.0"
curl -fLO "https://github.com/SchneiderDaniel/cheasee-pi/releases/download/v${VERSION}/cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz"
```

Adjust `VERSION` to the latest release tag.

### Step 2: Verify the checksum (optional but recommended)

Download the checksums file and verify the archive:

```bash
curl -fLO "https://github.com/SchneiderDaniel/cheasee-pi/releases/download/v${VERSION}/checksums.txt"
sha256sum --check checksums.txt --ignore-missing
```

Expected output includes `cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz: OK`.

### Step 3: Extract and install

```bash
tar -xzf "cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz"
chmod +x cheasee-pi
sudo mv cheasee-pi /usr/local/bin/
```

> **macOS only:** Gatekeeper may block the unsigned binary. If you see
> "“cheasee-pi” cannot be opened because the developer cannot be verified",
> remove the quarantine attribute:
>
> ```bash
> xattr -d com.apple.quarantine /usr/local/bin/cheasee-pi
> ```
>
> Or Ctrl-click → Open in Finder and confirm.

Verify the binary works:

```bash
cheasee-pi version
```

### Step 4: Verify Docker is installed

```bash
docker compose version
docker info
```

If Docker is not installed, see the [platform-specific install table](#step-1-install-docker)
before proceeding.

### Step 5: Run `cheasee-pi init`

This single interactive command replaces Steps 3–5 of the legacy path (fork, clone,
submodule config, compose extraction, and env file generation).

```bash
cheasee-pi init
```

`cheasee-pi init` will:

1. Verify Docker Engine is running
2. Open GitHub OAuth device flow to authenticate (browser window)
3. Fork the source repo to your GitHub account
4. Clone your fork with a bare worktree setup
5. Configure the submodule (prompts for your repo URL)
6. Extract embedded `docker-compose.yml`, `Dockerfile`, and `entrypoint.sh`
7. Generate `docker/.env` with your settings
8. Save authentication config to your platform's XDG user config directory (e.g., `~/.config/cheasee-pi/auth.json` on Linux; the exact path is printed at runtime as "✓ Auth config saved to...")

After completion, you'll see:

```
✅ Init complete! Next step:
   docker compose -f docker/docker-compose.yml up -d --build
```

> **No GitHub?** Use `cheasee-pi init --no-github` to skip the GitHub OAuth and fork
> steps. You'll need to provide your API key manually.

### Step 6: Start the container

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

This runs `docker compose up` with the configuration extracted in Step 5,
building the OCI image (~2 min first time) and starting the container in
detached mode.

### Step 7: Enter the container

```bash
docker exec -it --user agentuser -w /workspaces/main cheasee-pi pi
```

On first run, pi will prompt you to configure your API key. Follow the
interactive setup.

To pass API keys from your host environment:

```bash
docker exec -it \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  --user agentuser -w /workspaces/main cheasee-pi pi
```

### Step 8: Configure repository settings

After forking, update `.pi/settings.json` so the pipeline targets your fork:

| Field | Type | Must change? | Description |
|-------|------|-------------|-------------|
| `supervisor.repo` | string | **Yes** | Your fork (`YOUR_USER/cheasee-pi`) |
| `supervisor.projectNumber` | number | If using kanban | GitHub project number |
| `supervisor.statusField` | string | If using kanban | Single-select field name |
| `defaultProvider` | string | Optional | AI provider for agents |
| `defaultModel` | string | Optional | Default model |
| `theme` | string | Optional | TUI theme from `.pi/themes/` |
| `docker.memory` | string | Optional | Container memory limit |
| `docker.cpus` | string | Optional | Container CPU limit |

```bash
nano .pi/settings.json
```

> **Done with setup?** See the [Daily Usage guide](daily-usage.md) for running pi,
> parallel sessions, stop/start, and troubleshooting.

---

## Legacy Bash Path

**For existing users or Windows (WSL2) users.** This is the original 8-step workflow
using the `./cheasee-pi.sh` bash wrapper. It requires `git`, `gh`, and manual
fork/clone/submodule setup.

### Step 1: Install Docker

Pick your platform:

| Platform    | Install Link                                                                                                            | Instructions |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Linux**   | [Docker Engine](https://docs.docker.com/engine/install/) + [Compose V2](https://docs.docker.com/compose/install/linux/) | `sudo sh -c "$(curl -fsSL https://get.docker.com)"` then `sudo groupadd -f docker && sudo usermod -aG docker $USER`, then `newgrp docker` to activate |
| **macOS**   | [OrbStack](https://orbstack.dev/) (fast, lightweight Docker + Compose V2)              | Download from orbstack.dev or `brew install orbstack` |
| **Windows** | [Docker Engine](https://docs.docker.com/engine/install/) inside WSL2 (Compose V2 included)                      | Enable VM platform: `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart` + restart (on Win ≥10 v2004, `wsl --install` does this automatically — skip `dism`). Then `wsl --install -d Ubuntu`. Inside WSL: `sudo sh -c "$(curl -fsSL https://get.docker.com)"` then `sudo groupadd -f docker && sudo usermod -aG docker $USER`, then `newgrp docker` to activate |

**Platform:** Docker-only. Linux native, macOS via OrbStack, Windows via WSL2 + Docker Engine.

> **Windows advice:** WSL2 is resource-heavy (RAM, disk). We strongly recommend Linux for the best experience. If using Windows, ensure your system has ≥16 GB RAM.

> ▶ **Execute — Linux:**
> ```bash
> sudo sh -c "$(curl -fsSL https://get.docker.com)"
> sudo groupadd -f docker
> sudo usermod -aG docker $USER
> newgrp docker
> ```
>
> **macOS:** download OrbStack or `brew install orbstack`.
>
> **Windows (WSL):** run the WSL setup first, then the same Linux commands inside WSL.

### Step 2: Install git & GitHub CLI — authenticate

> ▶ **Execute:**
> ```bash
> # Linux
> sudo apt install git gh
>
> # macOS
> brew install git gh
>
> # Windows (inside WSL)
> sudo apt install git gh
> ```

Set your git identity and authenticate with GitHub via browser:

> ▶ **Execute:**
> ```bash
> git config --global user.name "Your Name"
> git config --global user.email "your.email@example.com"
> gh auth login -s repo,project,workflow
> ```

`gh auth login` opens a browser for OAuth. Follow the prompts:
1. Select **GitHub.com**
2. Select **HTTPS**
3. Choose **Login with a web browser**
4. Copy the one-time code, press Enter to open browser
5. Paste the code, authorize
6. Terminal shows: `✓ Logged in as YOUR_USER`

Verify the token scopes:

> ▶ **Execute:**
> ```bash
> gh auth status
> ```

Expected output includes:
```text
Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'
```

Minimum scopes: `repo`, `project`, `workflow`. Re-run `gh auth login -s repo,project,workflow` if any are missing.

The container mounts `~/.config/gh/` read-only, so host auth works inside automatically.

### Step 3: Fork & clone the bare repo

Fork [github.com/SchneiderDaniel/cheasee-pi](https://github.com/SchneiderDaniel/cheasee-pi) to your GitHub account, then clone your fork:

> ▶ **Execute:**
> ```bash
> mkdir cheasee-pi && cd cheasee-pi
> git clone --bare https://github.com/YOUR_USER/cheasee-pi.git .bare
> git --git-dir=.bare remote add upstream https://github.com/SchneiderDaniel/cheasee-pi.git
> # Ensure origin has a fetch refspec
> git --git-dir=.bare config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
> ```

This creates a bare repo at `.bare` with **origin** pointing to your fork and **upstream** pointing to the source repo. The `config` line ensures `origin` has a fetch refspec — without it, `git fetch --all` silently skips `origin` (only `upstream` refs appear).

### Step 4: Create the worktree

> ▶ **Execute:**
> ```bash
> git --git-dir=.bare worktree add main main
> cd main
> git fetch --all
> ```

**⚠️ Fetch is required.** Without it, no remote-tracking branches (`origin/main`, `upstream/main`) exist locally. Git GUIs (Zed, VS Code, GitKraken…) will:
- Show **Publish** instead of **Fetch** — no upstream ref to compare against
- Hide the local-vs-remote commit overview — nothing to diff `HEAD` against
- Require re-selecting upstream on every branch switch

One `git fetch --all` populates all remote refs (`origin`, `upstream`) and makes any git GUI behave the same as on your other machines.

All worktrees live alongside each other under the workspace root. Feature branches get their own worktree (`../worktree-git-issue-*`). The container mounts the whole workspace so agents can access any worktree.

### Step 5: Configure the submodule

**⚠️ CRITICAL:** The project includes one submodule (`flask_blogs`) pointing to a **private** repo (`github.com/SchneiderDaniel/flask_blogs`). You do NOT have access. `git submodule update --init --recursive` as-is will **fail**.

Replace the URL with **your own project repo** (any public or private repo you own) before initializing:

> ▶ **Execute:**
> ```bash
> git submodule set-url flask_blogs https://github.com/YOUR_USER/YOUR_REPO.git
> git submodule sync
> git submodule update --init --recursive
> ```

To optionally track the original repo as upstream:

> ▶ **Execute:**
> ```bash
> git -C flask_blogs remote add upstream https://github.com/SchneiderDaniel/flask_blogs.git
> ```

> Don't want a submodule at all? Remove it:
> ```bash
> git submodule deinit -f flask_blogs
> git rm -f flask_blogs
> rm -rf .git/modules/flask_blogs
> ```

### Step 6: Start the container

> ▶ **Execute:**
> ```bash
> ./cheasee-pi.sh
> ```

First run builds the OCI image (~2 min), then drops you into the Pi TUI inside the container. The wrapper:
- Builds from `docker/Dockerfile`
- Starts the container with workspace root bind-mounted, UID/GID mapped
- Launches the Pi TUI

The container stays running — subsequent runs of `./cheasee-pi.sh` skip straight to the TUI.

### Step 7: Set API key

On first run, `./cheasee-pi.sh` detects no keys and launches interactive setup. Select your providers and enter keys. They're saved to your shell profile.

To add or change keys later:

> ▶ **Execute:**
> ```bash
> ./cheasee-pi.sh --configure
> ```

To override for a single session:

> ▶ **Execute:**
> ```bash
> ./cheasee-pi.sh --api-key "sk-..."
> ```

See `./cheasee-pi.sh --help` for all options.

### Step 8: Configure repository settings

After forking, **you must update** `.pi/settings.json` so the pipeline targets your fork instead of the original repo:

| Field | Type | Must change? | Description |
|-------|------|-------------|-------------|
| `supervisor.repo` | string | **Yes** | Your fork (`YOUR_USER/cheasee-pi`) |
| `supervisor.projectNumber` | number | If using kanban | GitHub project number |
| `supervisor.statusField` | string | If using kanban | Single-select field name |
| `defaultProvider` | string | Optional | AI provider for agents |
| `defaultModel` | string | Optional | Default model |
| `theme` | string | Optional | TUI theme from `.pi/themes/` |
| `docker.memory` | string | Optional | Container memory limit |
| `docker.cpus` | string | Optional | Container CPU limit |

> ▶ **Execute — edit the file:**
> ```bash
> # Change "SchneiderDaniel/cheasee-pi" → "YOUR_USER/cheasee-pi"
> nano .pi/settings.json
> ```

---

## IDE (optional)

Any IDE works with the workspace. We recommend [Zed](https://zed.dev/) for optimal experience:

```bash
curl -f https://zed.dev/install.sh | sh
sudo ln -s ~/.local/bin/zed /usr/local/bin/zed
```

Open the workspace: `zed .` from the `cheasee-pi` root.

## What happens under the hood

The `docker compose -f docker/docker-compose.yml up -d --build` command (or the legacy `./cheasee-pi.sh`) runs `docker compose up` with:

- Image built from `docker/Dockerfile` (Debian 12-slim, Node.js 22, Python 3, ripgrep, ast-grep, pi, gosu)
- Workspace root (`../` relative to `main/`) bind-mounted to `/workspaces` inside the container — your worktree at `/workspaces/main`
- Host UID/GID mapped to container user `agentuser` (no permission issues)
- Interactive TTY for the Pi TUI

## Verification

All checks run inside the container.

### Tool verification

```bash
# Structural search
pi "Use structural_search to find all console.log calls in TypeScript files"

# Text search
pi "Use ripgrep_search to find 'TODO' in the project"

# Web search
pi "Use web_search to find 'latest rust web framework 2026' with maxResults=5"
```

### Pi autonomy check

```bash
pi "Respond with exactly one word: 'Operational'."
```

### Execution routing test

```bash
pi -p "Create a file named '.pi/test-file.txt' with content 'container works', then tell me the absolute path."
```

**Expected:** `/workspaces/main/.pi/test-file.txt`

## Troubleshooting

### Container doesn't start

Rebuild the image without cache:

```bash
docker compose -f docker/docker-compose.yml build --no-cache
docker compose -f docker/docker-compose.yml up -d --build
```

Or for the legacy path:

```bash
docker compose -f docker/docker-compose.yml build --no-cache
./cheasee-pi.sh
```

### Permission errors on bind-mounted files

UID/GID mapping is automatic via `cheasee-pi.sh` or the Docker Compose command. If you need to run manually:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f docker/docker-compose.yml up
```

### Emoji / icons not displaying

Emoji icons (🧠, 🔧, 🔒, 📦, ⏱) in the footer bar or TUI appear as empty boxes
(`□`, `▯`) when the host terminal emulator lacks an emoji-capable font.

The container includes `fonts-noto-color-emoji` since Layer 3 of the Docker
image. The host terminal performs the final rendering, however — the container
merely transmits the encoded bytes.

**To verify inside the container:**

```bash
printf "\U1F9E0 \U1F527 \U1F512 \U1F4E6 \U23F1\n"
```

If the output displays correctly, the host terminal supports emoji and the issue
resides elsewhere (extension configuration, terminal encoding, Pi session
stale). If the output shows boxes, install an emoji font on the host:

```bash
# Debian / Ubuntu host
sudo apt install fonts-noto-color-emoji

# Fedora / RHEL
sudo dnf install google-noto-color-emoji-fonts

# macOS / Windows — fonts are bundled; no action required
```

After installing, rebuild font cache and restart the Pi session:

```bash
sudo fc-cache -fv
# Exit pi (/exit), then restart:
docker compose -f docker/docker-compose.yml up -d
# Or legacy:
./cheasee-pi.sh
```

**Nerd Font for git branch icon:** The footer also uses `` (U+E0A0) from
[Nerd Font](https://www.nerdfonts.com/) for the git branch indicator. Noto
Color Emoji does not cover this. Install a Nerd Font on the host:

```bash
wget -P /tmp https://github.com/ryanoasis/nerd-fonts/releases/download/v3.3.0/JetBrainsMono.zip
sudo unzip /tmp/JetBrainsMono.zip -d /usr/share/fonts/truetype/jetbrains-nerd
sudo fc-cache -fv
```

Then configure Zed (if using it) to use the Nerd Font:

```json
{
  "terminal": {
    "font_family": "JetBrainsMono Nerd Font"
  }
}
```

The project-level `.zed/settings.json` already contains this setting — adjust
the font name to match the Nerd Font you installed.

**Rebuild the container after any Dockerfile change:**

```bash
docker compose -f docker/docker-compose.yml up -d --build
# Or legacy:
./cheasee-pi.sh
```

---

> **Next steps?** After installation, head over to the [Daily Usage guide](daily-usage.md)
> for running pi, managing parallel sessions, stop/start workflows, and troubleshooting.
