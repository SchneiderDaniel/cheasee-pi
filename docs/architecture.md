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
> **Pi resources:** at build time the image clones cheasee-pi's own repository
> (github.com/SchneiderDaniel/cheasee-pi, Dockerfile `ARG CHEASEE_REF`,
> default `main`) into `/opt/cheasee-pi` and
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
- curl (HTTP client)
- unzip (archive extraction)
- GitHub CLI (gh)

## UI service (web control center)

The compose stack runs a third managed service alongside `cheasee-pi` and
`codeflow`: a local `ui` sidecar — the cheasee-pi web control center (a Leptos
shell served by Axum). It mounts the workspace at `/workspaces/main` read-write
so it can list, attach to, and stop pi sessions, and mounts `~/.config/gh` +
`~/.config/cheasee-pi` **read-only** because those can hold plaintext
credentials and the server is reachable from the host browser.

**Loopback-only publish invariant.** The compose mapping is
`127.0.0.1:${PI_UI_PORT:-9500}:3000`. The explicit `127.0.0.1` host prefix is
what pins the published port to loopback — Docker otherwise listens on all host
interfaces (`0.0.0.0` / `::`) for a published port. There is no all-interfaces
opt-in (unlike CodeFlow's `CODEFLOW_HOST_IP`): the control center is never
routable off-host. The two binds are distinct and both required: the container
side binds `0.0.0.0:3000` (docker-proxy/DNAT must reach it) while the host side
is published on `127.0.0.1:<port>` only.

**No `docker.sock`.** The `ui` service does not mount `/var/run/docker.sock` and
never will: the Docker daemon runs as root and trusts any client that can write
to the socket, so a container holding it is host-root-equivalent — it can
request privileged containers and host mounts without ever escaping. The sidecar
therefore never talks to the Docker API; session control goes through the
shared workspace mount, not the daemon.

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
  to `<parent>/.bare` → worktree attach on the repo's default branch (bare
  HEAD via `symbolic-ref`) → `cheasee-settings.json`),
  then stops — init never launches pi; a second `cheasee-pi start` runs the
  normal start phases (docker check → compose up → exec pi).
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
