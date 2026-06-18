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

| Platform    | Install Link                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Linux**   | [Docker Engine](https://docs.docker.com/engine/install/) + [Compose V2](https://docs.docker.com/compose/install/linux/) |
| **macOS**   | [OrbStack](https://orbstack.dev/) (fast, lightweight Docker + Compose V2)              |
| **Windows** | [Docker Engine](https://docs.docker.com/engine/install/) inside WSL2 (Compose V2 included)                      |

**Platform:** Docker-only. Linux native, macOS via OrbStack, Windows via WSL2 + Docker Engine.

## Quick start

```bash
git clone --bare git@github.com:SchneiderDaniel/cheasee-pi.git .bare
git --git-dir=.bare worktree add main main
cd main
./cheasee-pi.sh
```

The wrapper script:
1. Builds the OCI image from `docker/Dockerfile` (first run, ~2 min)
2. Starts the container with the workspace root bind-mounted, UID/GID mapped
3. Drops you into the Pi TUI inside the container

## Step-by-step

### 1. Clone the bare repo

```bash
mkdir cheasee-pi && cd cheasee-pi
git clone --bare git@github.com:SchneiderDaniel/cheasee-pi.git .bare
```

This creates a bare repo at `.bare` — no working tree yet.

### 2. Create the `main` worktree

```bash
git --git-dir=.bare worktree add main main
cd main
```

All worktrees live alongside each other under the workspace root. Feature branches get their own worktree (`../worktree-git-issue-*`). The container mounts the whole workspace so agents can access any worktree.

### 3. Start the container

```bash
./cheasee-pi.sh
```

Builds the image (first run, ~2 min) and drops you into the Pi TUI inside the container.

### 4. Set provider (first session only)

```bash
pi --provider opencode-go --api-key "your-key"
```

Exit with `Ctrl+C` twice. The provider is persisted in `.pi/settings.json`.

### 5. Configure `.pi/settings.json`

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

## Makefile commands

| Command       | Description                         |
| ------------- | ----------------------------------- |
| `make up`     | Build image and start container     |
| `make shell`  | Enter container shell                |
| `make pi`     | Launch pi agent inside container     |

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
