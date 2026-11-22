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

### Startup flow

A plain `cheasee-pi` / `cheasee-pi start` is a per-service reconcile over the
three stack services (`cheasee-pi`, `codeflow`, `ui`), not a reshape of the
whole Compose project:

1. One `docker ps -a` probe classifies each service container as _up_,
   _start_, or _missing_ (`containerStates`).
2. Existing stopped containers are started with `docker start <container>` —
   Compose never sees them, so no recreate happens and stale Compose config is
   left untouched.
3. For missing containers only: `docker image inspect` decides whether the
   image is absent; absent images are built with a service-scoped
   `docker compose build <svc>`, and the missing containers are created with
   `docker compose up -d --no-build --pull never <svc>`. `--remove-orphans` is
   deliberately omitted, so creating one missing service can never delete an
   existing container (orphan reaping stays `cheasee-pi clean`'s job).

`--build` is the explicit rebuild opt-in and keeps the coarse
`compose build` (all services) + `compose up -d --remove-orphans` path. Any
docker failure on the normal path is reported as-is — there is no
build/recreate fallback.

## UI service (web control center)

The compose stack runs a third managed service alongside `cheasee-pi` and
`codeflow`: a local `ui` sidecar — the cheasee-pi web control center (a Leptos
shell served by Axum). It mounts the workspace at `/workspaces/main` read-write
so it can list, attach to, and stop pi sessions, and receives the provider
credentials as the same read-only, file-backed secret the agent gets
(`/run/secrets/cheasee_auth`, sourced from `~/.config/cheasee-pi/auth.json`)
because the server is reachable from the host browser. No host config directory
is mounted, so the sidecar has no write path to host credentials.

**Loopback-bound publish.** The compose mapping is
`127.0.0.1:${PI_UI_PORT:-9500}:3000`. The explicit `127.0.0.1` host prefix is
what pins the published port to loopback — Docker otherwise listens on all host
interfaces (`0.0.0.0` / `::`) for a published port. There is no all-interfaces
opt-in (unlike CodeFlow's `CODEFLOW_HOST_IP`). The two binds are distinct and
both required: the container side binds `0.0.0.0:3000` (docker-proxy/DNAT must
reach it) while the host side is published on `127.0.0.1:<port>` only.

This is loopback-bound configuration, not a hard isolation boundary. Docker
Engine before 28.0.0 may expose a loopback-published port to hosts on the same
L2 segment, and this project accepts Engine 24.0.0 and later, so the `ui` port
inherits that caveat on those engines. Hardening the mapping (and the deferred
non-localhost opt-in) is tracked under #1527.

**No `docker.sock`.** The `ui` service does not mount `/var/run/docker.sock` and
never will: the Docker daemon runs as root and trusts any client that can write
to the socket, so a container holding it is host-root-equivalent — it can
request privileged containers and host mounts without ever escaping. The sidecar
therefore never talks to the Docker API; session control goes through the
shared workspace mount, not the daemon.

**Cross-instance discovery.** A sidecar can only see its own workspace, so
finding peers is a CLI job: the CLI is the only layer that owns container
identity, docker liveness and a host filesystem view. `cheasee-pi start` records
the instance in `<user cache>/cheasee-pi/instances/<instance-key>.json`
(`{key, label, uiPort, codeflowPort, startedAt, agentContainer}` — labels, ports
and the one container name the run used, never a host path), `cheasee-pi down`
removes it, and the CLI publishes a read-only snapshot
(`<user cache>/cheasee-pi/instances.json`) that the `ui` service bind-mounts at
`/run/cheaseepi/instances.json:ro`. Both ports are the ones the sidecars
actually published (`docker port`), not the derive+probe result: at registration
time the containers already hold their binds, so a probe would read its own
sidecar as occupancy and shift to the next free port. Liveness is resolved from
`docker ps -a` at snapshot-write time against the recorded `agentContainer`
(`start --name` overrides the derived name), so a record left behind by a host
crash is dropped instead of surfacing as an available instance, and a
custom-named instance is never mistaken for a missing one. Publication is a
read–probe–write cycle and runs under one host-wide lock
(`<user cache>/cheasee-pi/instances.json.lock`), with the registry listed
_inside_ it: two starts finishing out of order can then never let a slower
refresh overwrite a newer, more complete view — the last writer re-reads the
registry, so a workspace that started in between is never dropped. When that
resolution fails — docker unreachable, a corrupt peer record — the published
snapshot is invalidated to an empty list, so the `ui` stops advertising peers the
CLI can no longer confirm, and the fault is reported on stderr. The sidecar
renders the snapshot and links to each peer's own loopback UI port; it never
probes the host, never scans port bands and never gains a daemon view.

## Shared extension library (`lib/`)

The `.pi/extensions/lib/` directory contains shared TypeScript modules used across multiple extensions, avoiding code duplication:

| Module                       | Used by               | Purpose                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extension-state.ts`         | session-logger        | File-backed state persistence with sequential write queue                                                                                                                                                                                                                                                                                                                |
| `bash-query.ts`              | agent-harness         | Pure-function bash classification — detect `grep`/`cat` misuse, pipe patterns                                                                                                                                                                                                                                                                                            |
| `ensureVenv.ts`              | scrapling, web-search | Python venv auto-creation and dependency installation                                                                                                                                                                                                                                                                                                                    |
| `proper-lockfile-ambient.ts` | session-logger        | Ambient type declarations for proper-lockfile. **Mandatory:** any consumer of `lockfile.lock()` MUST pass a custom `onCompromised` handler that logs a warning via `onUpdate` instead of throwing (otherwise the upstream default `throw` crashes the process from inside a `setTimeout` callback — see #1136). The canonical handler is in `ensureVenv.ts:acquireLock`. |
| `tsc-types.ts`               | tsc-checkpoint        | Reusable TypeScript compiler API types                                                                                                                                                                                                                                                                                                                                   |

These are not extensions themselves — they are imported by extension code via relative imports.

The repo root is bind-mounted at `/workspaces/main`. Host UID/GID are mapped to container user `agentuser`.

## Workspace layout & settings split

`cheasee-pi start` gates on the workspace state instead of “is a git repo”:

- **Empty folder** → auto-runs `cheasee-pi init` (repo-URL prompt → bare clone
  to `<parent>/.bare` → worktree attach on the repo's default branch (bare
  HEAD via `symbolic-ref`) → `cheasee-settings.json`),
  then stops — init never launches pi; a second `cheasee-pi start` runs the
  normal start phases (docker check → start existing containers, create only
  missing ones → exec pi).
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
