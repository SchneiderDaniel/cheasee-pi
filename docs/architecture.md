---
layout: default
title: Architecture
nav_order: 4
---

# Architecture

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## System overview

```
┌────────────────────────────────────────────────────┐
│  Terminal (Docker)                                  │
│  ┌──────────────────────────────────────────────┐  │
│  │  Pi TUI (Terminal) — cheasee-pi theme       │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │  │
│  │  │ Exts     │ │ AI Prov │ │ Rich Footer  │ │  │
│  │  │ .pi/     │ │OpenCode  │ │branch model  │ │  │
│  │  │ exts/    │ │Go/...    │ │tokens TPS    │ │  │
│  │  └───┬──────┘ └──────────┘ └──────────────┘ │  │
│  │      │                                        │  │
│  └──────┼────────────────────────────────────────┘  │
└─────────┼───────────────────────────────────────────┘
          │
     ┌────▼────────────────────────────┐
     │  External tools                  │
     │  ┌──────────┐ ┌───────────────┐ │
     │  │ ast-grep │ │ web-search    │ │
     │  │structural│ │ DuckDuckGo    │ │
     │  │_search   │ │ (ddgs)        │ │
     │  └──────────┘ └───────────────┘ │
     │  ┌──────────┐ ┌───────────────┐ │
     │  │ ripgrep  │ │ scrapling    │ │
     │  │ripgrep_  │ │Python venv    │ │
     │  │search    │ │(zero-browser) │ │
     │  └──────────┘ └───────────────┘ │
     └─────────────────────────────────┘
```

**Key principle:** All tools run locally. Web crawling runs on host (network-only for crawl). ast-grep, ripgrep are system binaries invoked via `pi.exec()`. No MCP servers, no network-exposed tool endpoints.

## Extensions vs MCP

This project deliberately avoids the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). All tools are **pi extensions** — TypeScript files in `.pi/extensions/` that run inside the agent's Node.js runtime. No external MCP servers, no network-exposed tool endpoints, no separate processes.

**The reason: token efficiency.**

MCP servers expose full JSON Schema tool descriptions to the LLM on every request. Pi extensions use **prompt snippets** — concise one-line descriptions (~50-120 tokens vs ~300-800 for MCP). Full schema is only loaded when the tool is actually called. Saves thousands of tokens per turn.

## Multi-agent pipeline

The supervisor orchestrates a 5-step pipeline:

```
Researcher → Architect → TestDesigner → Developer → Auditor
```

Each agent is a Markdown file in `.pi/extensions/supervisor/agents/` with YAML frontmatter defining tools, skills, and model. See [Extensions → Supervisor](extensions/supervisor) for the full agent table.

## Docker container

The container is built from `cmd/cheasee-pi/embedded/docker/Dockerfile` (Debian 12-slim) and includes:

> **Single source of truth:** the docker tree lives at
> `cmd/cheasee-pi/embedded/docker/` (real files there are required by
> `//go:embed embedded` in `embed.go`; the build fails if the pattern matches
> no files). The CLI extracts this subtree at runtime to a version-keyed cache
> dir (the docker compose build context). Docker-only extras at repo root
> (`docker/test/`, `docker-compose.legacy.yml`) stay tracked for dev/CI use.
>
> **Pi resources:** the image clones the cheasee-pi repo at build time
> (Dockerfile `ARG CHEASEE_REF`, default `main`) into `/opt/cheasee-pi` and
> symlinks its resource dirs (.pi/skills, .pi/prompts, .pi/extensions,
> .pi/themes) into `~/.pi/agent/` (global pi resources), so the Cheasee-Pi
> experience is available inside any mounted repo. No generated resource
> mirror is embedded — the repo is the single source of truth. State dirs
> (agent/, context/, sessions/, git/, venvs) are gitignored and never reach
> the image.

- Node.js 22
- Python 3 + pip + venv
- ripgrep
- ast-grep
- Pi coding agent
- gosu (for UID/GID mapping)
- jq (JSON processor)
- universal-ctags (code indexing)
- jscpd (duplicate code detection)
- wget / curl (HTTP clients)
- unzip (archive extraction)
- GitHub CLI (gh)

## Shared extension library (`lib/`)

The `.pi/extensions/lib/` directory contains shared TypeScript modules used across multiple extensions, avoiding code duplication:

| Module | Used by | Purpose |
|--------|---------|---------|
| `extension-state.ts` | session-logger, caveman | File-backed state persistence with sequential write queue |
| `bash-query.ts` | agent-harness | Pure-function bash classification — detect `grep`/`cat` misuse, pipe patterns |
| `ensureVenv.ts` | scrapling, web-search | Python venv auto-creation and dependency installation |
| `proper-lockfile-ambient.ts` | session-logger | Ambient type declarations for proper-lockfile. **Mandatory:** any consumer of `lockfile.lock()` MUST pass a custom `onCompromised` handler that logs a warning via `onUpdate` instead of throwing (otherwise the upstream default `throw` crashes the process from inside a `setTimeout` callback — see #1136). The canonical handler is in `ensureVenv.ts:acquireLock`. |
| `tsc-types.ts` | tsc-checkpoint | Reusable TypeScript compiler API types |

These are not extensions themselves — they are imported by extension code via relative imports.

The repo root is bind-mounted at `/workspaces/main`. Host UID/GID are mapped to container user `agentuser`.
## Workspace layout & settings split

`cheasee-pi start` gates on the workspace state instead of “is a git repo”:

- **Empty folder** → auto-runs `cheasee-pi init` (repo-URL prompt → bare clone
  to `<parent>/.bare` + `worktree add --detach` → `cheasee-settings.json`).
- **`cheasee-settings.json` present** → initialized; runs normally.
- **Non-empty folder without settings** → refused (“not initialized; run
  `cheasee-pi init` in an empty folder”).

The dedicated, gitignored `cheasee-settings.json` at the folder root is the
initialized marker and the single source for compose env (`docker.memory` →
`CHEASEEPI_MEMORY`, `docker.cpus` → `CHEASEEPI_CPUS`, `gitIdentity` →
`HOST_GIT_NAME`/`HOST_GIT_EMAIL`). Pi's own `.pi/settings.json` is no longer
scaffolded or read by the CLI — pi self-scaffolds it on first run.

The container sees two sibling bind mounts: the workspace folder →
`/workspaces/main` and `<parent>/.bare` → `/workspaces/.bare` (never a single
parent-of-folder mount). The entrypoint marks `/workspaces/.bare` as
`safe.directory` (CVE-2022-24765 dubious-ownership mitigation), chowns it on
ownership mismatch, and `worktree-fix.sh` rewrites/locks the worktree paths.

The empty-folder clone authenticates via the gh credential helper
(`git -c credential.helper="!gh auth git-credential"`), never a token-bearing
URL — git persists `remote.origin.url` verbatim in `.bare/config`.
