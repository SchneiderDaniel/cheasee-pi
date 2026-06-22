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

**Dependencies:** [Docker Engine](https://docs.docker.com/engine/install/) ≥24.0 with Compose V2 + [git](https://git-scm.com/) + [GitHub CLI](https://cli.github.com/) (`gh`).

Git identity is required so the supervisor extension can commit changes inside the
container. The host's `git config user.name` and `git config user.email` are passed
into the container automatically by `cheasee-pi.sh`. If unset on the host, the
container defaults to `Cheasee-Pi <cheasee-pi@localhost>`.



## Installation

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
> ```

This creates a bare repo at `.bare` with **origin** pointing to your fork and **upstream** pointing to the source repo.

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

## IDE (optional)

Any IDE works with the workspace. We recommend [Zed](https://zed.dev/) for optimal experience:

```bash
curl -f https://zed.dev/install.sh | sh
sudo ln -s ~/.local/bin/zed /usr/local/bin/zed
```

Open the workspace: `zed .` from the `cheasee-pi` root.

## What happens under the hood

`./cheasee-pi.sh` runs `docker compose up` with:

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
./cheasee-pi.sh
```

### Permission errors on bind-mounted files

UID/GID mapping is automatic via `cheasee-pi.sh`. If you need to run manually:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f docker/docker-compose.yml up
```

