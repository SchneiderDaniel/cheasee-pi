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
> `//go:embed embedded` in `embed.go`). The repo-root `docker/` tree is a
> generated build artifact for the dev-facing compose workflow — on a fresh
> clone run `make docker-tree` before compose-from-repo-root, and `make
> check-docker` to verify sync. Docker-only extras (`docker/test/`,
> `docker-compose.legacy.yml`) stay tracked and are never touched by the sync.
>
> **Pi resources:** the tracked `.pi/` resources (skills, prompts, extensions,
> themes + package.json/tsconfig.json) are synced to
> `cmd/cheasee-pi/embedded/pi-resources/` via `make pi-tree` (`make check-pi`
> verifies sync). The CLI extracts them into the image at `/opt/cheasee-pi` and
> symlinks them into `~/.pi/agent/` (global pi resources), so the Cheasee-Pi
> experience is available inside any mounted repo. State dirs (agent/,
> context/, sessions/, git/, venvs) never bake into the image.

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