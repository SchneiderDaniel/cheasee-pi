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

**One dependency:** Docker Engine ≥24.0 with Compose V2.

| Platform    | Install Link                                                                                                            | Instructions |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Linux**   | [Docker Engine](https://docs.docker.com/engine/install/) + [Compose V2](https://docs.docker.com/compose/install/linux/) | `sudo sh -c "$(curl -fsSL https://get.docker.com)"` then `sudo usermod -aG docker $USER` |
| **macOS**   | [OrbStack](https://orbstack.dev/) (fast, lightweight Docker + Compose V2)              | Download from orbstack.dev or `brew install orbstack` |
| **Windows** | [Docker Engine](https://docs.docker.com/engine/install/) inside WSL2 (Compose V2 included)                      | Enable VM platform: `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart` + restart (on Win ≥10 v2004, `wsl --install` does this automatically — skip `dism`). Then `wsl --install -d Ubuntu`. Inside WSL: `sudo sh -c "$(curl -fsSL https://get.docker.com)"` then `sudo usermod -aG docker $USER` |

**Platform:** Docker-only. Linux native, macOS via OrbStack, Windows via WSL2 + Docker Engine.



## Quick start

```bash
# 1. Fork https://github.com/SchneiderDaniel/cheasee-pi on GitHub
# 2. Clone your fork (bare)
git clone --bare git@github.com:YOUR_USER/cheasee-pi.git .bare
# 3. Add upstream remote
git --git-dir=.bare remote add upstream git@github.com:SchneiderDaniel/cheasee-pi.git
# 4. Create main worktree
git --git-dir=.bare worktree add main main
cd main
# 5. Replace private submodule URL with your own repo (REQUIRED - see 2b below)
git submodule set-url flask_blogs git@github.com:YOUR_USER/YOUR_REPO.git
# 6. Init submodules
git submodule update --init --recursive
# 7. Start
./cheasee-pi.sh
```

The wrapper script:
1. Builds the OCI image from `docker/Dockerfile` (first run, ~2 min)
2. Starts the container with the workspace root bind-mounted, UID/GID mapped
3. Drops you into the Pi TUI inside the container

## Step-by-step

### 1. Fork & clone the bare repo

Fork [github.com/SchneiderDaniel/cheasee-pi](https://github.com/SchneiderDaniel/cheasee-pi) to your GitHub account, then clone your fork:

```bash
mkdir cheasee-pi && cd cheasee-pi
git clone --bare git@github.com:YOUR_USER/cheasee-pi.git .bare
git --git-dir=.bare remote add upstream git@github.com:SchneiderDaniel/cheasee-pi.git
```

This creates a bare repo at `.bare` with **origin** pointing to your fork and **upstream** pointing to the source repo.

### 2. Create the `main` worktree

```bash
git --git-dir=.bare worktree add main main
cd main
```

All worktrees live alongside each other under the workspace root. Feature branches get their own worktree (`../worktree-git-issue-*`). The container mounts the whole workspace so agents can access any worktree.

### 2b. Submodules — replace the private submodule

**⚠️ CRITICAL:** The project includes one submodule (`flask_blogs`) pointing to a **private** repo (`github.com/SchneiderDaniel/flask_blogs`). You do NOT have access. Running `git submodule update --init --recursive` as-is will **fail** with a permission error.

You must replace the URL with **your own project repo** (any public or private repo you own) before initializing:

```bash
git submodule set-url flask_blogs git@github.com:YOUR_USER/YOUR_REPO.git
git submodule sync
```

Now init:

```bash
git submodule update --init --recursive
```

> If you don't want a submodule at all, remove it entirely:
> ```bash
> git submodule deinit -f flask_blogs
> git rm -f flask_blogs
> rm -rf .git/modules/flask_blogs
> ```

To track the original repo as upstream:

```bash
git -C flask_blogs remote add upstream https://github.com/SchneiderDaniel/flask_blogs.git
```

### 3. Start the container

```bash
./cheasee-pi.sh
```

Builds the image (first run, ~2 min) and drops you into the Pi TUI inside the container.

### 4. Set API key

On first run, `./cheasee-pi.sh` detects no keys and launches interactive setup:

```
No API keys configured yet.

Configuring API keys for pi providers...
Shell profile: ~/.bashrc

Available providers:
  [1] OPENAI_API_KEY         OpenAI GPT API key
  [2] ANTHROPIC_API_KEY      Anthropic Claude API key
  [3] OPENCODE_API_KEY       OpenCode Zen/OpenCode Go API key
  [4] DEEPSEEK_API_KEY       DeepSeek API key
  [5] GEMINI_API_KEY         Google Gemini API key
  ...

Enter numbers (e.g., '1 3 5'), 'all', or 'q':
>
```

Select which providers to configure, enter each key once. Keys are saved to your shell profile and used immediately.

The container stays running, so subsequent runs of `./cheasee-pi.sh` skip straight to launching pi — no repeated prompts.

To add or change API keys later:

```bash
./cheasee-pi.sh --configure
```

To override for a single session:

```bash
./cheasee-pi.sh --api-key "sk-..."
```

Run `./cheasee-pi.sh --help` for all options.

### 5. GitHub CLI authentication

The kanban pipeline uses `gh` to manage issues, projects, and PRs. Auth is mounted read-only into the container from your host, so you authenticate on the host once and it works inside the container.

**Step 1 — Check current status:**

```bash
gh auth status
```

If already authenticated, verify required scopes are present:

```text
Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'
```

Minimum required: `repo`, `project`, `workflow`. If any are missing, re-authenticate with the full scope list.

**Step 2 — Authenticate (if needed):**

```bash
gh auth login -s repo,project,workflow
```

This opens a browser to generate a token with the exact scopes needed. Follow the prompts:

1. Select **GitHub.com**
2. Select **HTTPS** (or SSH if you prefer)
3. Choose **Login with a web browser**
4. Copy the one-time code, press Enter to open browser
5. Paste the code on github.com, authorize
6. Terminal shows: `✓ Logged in as YOUR_USER`

To verify after login:

```bash
gh auth status
```

Expected output:

```text
github.com
  ✓ Logged in to github.com account YOUR_USER (...)
  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'
```

> The container mounts `~/.config/gh/` at startup. If you authenticate after the container is already running, the new token is visible immediately — no restart needed.

### 6. Configure `.pi/settings.json` (optional)

`.pi/settings.json` stores all per-repo configuration. Key fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultProvider` | string | `"opencode-go"` | AI provider for agent sessions |
| `defaultModel` | string | `"deepseek-v4-flash"` | Default model (per-agent overrides in supervisor) |
| `quietStartup` | boolean | `false` | Skip startup banner |
| `theme` | string | `"cheasee-pi"` | TUI theme name from `.pi/themes/` |
| `sessionDir` | string | `".pi/sessions"` | Session log output directory |
| `contextStatusBar.showTps` | boolean | `true` | Show tokens/sec in TUI footer |
| `docker.memory` | string | `"4G"` | Container memory limit |
| `docker.cpus` | string | `"2.0"` | Container CPU limit |
| `supervisor.*` | object | — | Pipeline config — see [GitHub](github) page |

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
docker compose build --no-cache
./cheasee-pi.sh
```

### Permission errors on bind-mounted files

UID/GID mapping is automatic via `cheasee-pi.sh`. If you need to run manually:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f docker/docker-compose.yml up
```

## Daily workflow

### Typical session

1. Start with `pi`
2. Select or create a GitHub issue
3. Run `/supervisor <issue-number>` to start the pipeline
4. Monitor progress via TUI status bar
5. Review results when pipeline completes

## Contributing

1. Fork the repository
2. Create a feature worktree: `git worktree add -b my-feature ../my-feature main`
3. `cd ../my-feature` and make your changes
4. Run tests: `npm test`
5. Push and submit a PR
6. Clean up: `cd /path/to/main && git worktree remove --force ../my-feature`
