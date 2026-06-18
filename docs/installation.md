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

**API keys:** Copy `docker/agent_env.example` to `.agent_env` and fill in your keys.

## Quick start

```bash
git clone git@github.com:SchneiderDaniel/cheasee-pi.git
cd cheasee-pi
./cheasee-pi.sh
```

The wrapper script:
1. Builds the OCI image from `docker/Dockerfile` (first run, ~2 min)
2. Starts the container with your repo bind-mounted, API keys loaded, UID/GID mapped
3. Drops you into the Pi TUI inside the container

## Step-by-step

### 1. Clone the repo

```bash
git clone git@github.com:SchneiderDaniel/cheasee-pi.git && cd cheasee-pi
```

### 2. Configure API keys

```bash
cp docker/agent_env.example .agent_env
# Edit .agent_env with your keys
```

Required keys:
- `APIFY_TOKEN` — For web crawling
- Your LLM provider API key (e.g., OpenCode, Anthropic, OpenAI)

### 3. Launch

```bash
./cheasee-pi.sh
```

### 4. Set provider (first session only)

```bash
pi --provider opencode-go --api-key "your-key"
```

Exit with `Ctrl+C` twice. The provider is persisted in `.pi/settings.json`.

## What happens under the hood

`./cheasee-pi.sh` runs `docker compose up` with:

- Image built from `docker/Dockerfile` (Debian 12-slim, Node.js 22, Python 3, ripgrep, ast-grep, pi, gosu)
- Repo root bind-mounted to `/workspaces/main` inside the container
- `.agent_env` file mounted and sourced automatically
- Host UID/GID mapped to container user `agentuser` (no permission issues)
- Interactive TTY for the Pi TUI

## Verification

All checks run inside the container.

### Environment

```bash
echo $APIFY_TOKEN   # Should print your token
```

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

## Daily commands

| Action                  | Command                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Start session           | `pi`                                                                                 |
| Run supervisor pipeline | `/supervisor <issue-number>`                                                         |
| Run TSC type-check      | `/check`                                                                             |
| Toggle session advice   | `/session-advice on` / `/session-advice off`                                         |
| Toggle session logger   | `/session-logger on` / `/session-logger off`                                         |
| Toggle caveman level    | `/caveman` (cycle: lite → full → off)                                                |
| Design an extension     | `/extension-spec <idea>`                                                             |
| Write handover          | `/handover`                                                                          |
| Quiz PR reviewer        | `/quiz-master`                                                                       |
| View session logs       | `ls .pi/sessions/`                                                                   |
| Reload config           | `/reload` (after editing .piignore, settings.json, etc.)                             |

## Troubleshooting

### Container doesn't start

Rebuild the image without cache:

```bash
docker compose build --no-cache
./cheasee-pi.sh
```

### Web crawl fails with Chromium errors

The extension auto-installs system libraries inside the container. If it persists:

```bash
rm -rf .pi/scrapling-venv    # Next call auto-recreates
```

### Permission errors on bind-mounted files

UID/GID mapping is automatic via `cheasee-pi.sh`. If you need to run manually:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up
```

### `gh auth status` shows "not logged in"

Inside the container:

```bash
gh auth login
```

Authenticate with **Login with a web browser**.

### `.piignore` blocking legitimate paths

Edit `.piignore` and add a negation pattern:

```
!path/to/allow
```

Reload with `/reload`.

## Contributing

1. Fork the repository
2. Create a feature branch (`git worktree add -b feature/amazing feature-amazing`)
3. Make your changes
4. Run tests: `npm test`
5. Submit a PR
