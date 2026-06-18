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
| **macOS**   | [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac/) (includes Engine + Compose V2)                     |
| **Windows** | WSL2 + [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows/)                                         |

**Platform:** Docker-only. Linux native, macOS via Docker Desktop, Windows via WSL2 + Docker Desktop.

## Quick start

```bash
git clone git@github.com:SchneiderDaniel/cheasee-pi.git
cd cheasee-pi
./cheasee-pi.sh
```

The wrapper script:
1. Builds the OCI image from `docker/Dockerfile` (first run, ~2 min)
2. Starts the container with your repo bind-mounted, UID/GID mapped
3. Drops you into the Pi TUI inside the container

## Step-by-step

### 1. Clone the repo

```bash
git clone git@github.com:SchneiderDaniel/cheasee-pi.git && cd cheasee-pi
```

### 2. Set provider (first session only)

```bash
pi --provider opencode-go --api-key "your-key"
```

Exit with `Ctrl+C` twice. The provider is persisted in `.pi/settings.json`.

### 3. Configure `.pi/settings.json`

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
- Repo root bind-mounted to `/workspaces/main` inside the container
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
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up
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
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Submit a PR
