---
layout: default
title: Daily Usage
nav_order: 3
---

# Daily Usage

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Prerequisites

> Command-level reference (flags, checks, inputs): [CLI Reference](cli.md).

Before running pi via Docker, ensure the following are in place:

- **Docker Engine** running with Compose V2 (verified by `docker compose version`)
- **GitHub CLI authenticated** on the host — `gh auth status` shows `Logged in to github.com`
- **Emoji font** on the host terminal (see [Installation > Troubleshooting](installation.md#emoji--icons-not-displaying) for setup)
- **First-time build complete** — the Docker image must be built at least once. See [Start](#start-the-container) below.
- **A cheasee-pi workspace** — run `cheasee-pi init` in an empty folder to set
  one up (bare clone + main worktree + `cheasee-settings.json`), or just run
  `cheasee-pi start` in an empty folder — it auto-inits first and continues
  into start in the same invocation. Re-authenticate later (revoked GitHub
  token, rotated API keys) with `cheasee-pi init --reauth` in the workspace —
  it redoes the GitHub OAuth and pi API-key authentications.

The container mounts `~/.config/gh/` read-write, so host GitHub authentication works
automatically inside the container.

> **Note about UID/GID:** The entrypoint auto-detects `HOST_UID` and `HOST_GID` from the
> `/workspaces/main` mount ownership. On macOS (OrbStack) and Windows (WSL2), bind-mount
> permissions may differ — if you encounter permission errors, pass them explicitly:
> ```bash
> WORKSPACE_HOST_PATH=$(pwd) WORKSPACE_BARE_PATH=$(dirname "$(pwd)")/.bare \
>   HOST_UID=$(id -u) HOST_GID=$(id -g) \
>   docker compose -f ~/.cache/cheasee-pi/<version>/docker-compose.yml up -d
> ```

## Start the container

### First run (build + start)

```bash
cheasee-pi start --build
```

This builds the Docker image from the CLI cache dir (`~/.cache/cheasee-pi/<version>/`,
~2 min first time) and starts the container in detached mode. The container runs
`sleep infinity` and stays alive until you stop it.

**What happens:**
- Compose/Dockerfile are extracted to the CLI cache dir; the image clones
  the cheasee-pi repo at build time (`ARG CHEASEE_REF`, default `main`)
  into `/opt/cheasee-pi` and symlinks its resources into `~/.pi/agent/`
- Your workspace (main worktree) is bind-mounted to `/workspaces/main`, its
  sibling bare repo to `/workspaces/.bare` (two sibling mounts — the
  entrypoint rewrites worktree paths relative and locks them)
- CodeFlow service is built from the cache dir's `codeflow/` subtree
- Entrypoint auto-detects UID/GID from the mount and remaps the `agentuser` user
- npm dependencies are installed on first start (~30-60s)

The workspace's `cheasee-settings.json` (scaffolded by init, gitignored) is
read for docker memory/cpus and git identity. pi's own `.pi/settings.json` is
self-scaffolded by pi on its first run.

### Subsequent starts

```bash
cheasee-pi start
```

Without `--build`, a running container is reused — start execs pi directly
(~2s). A stopped container is rebuilt first (the pi layer re-resolves
`@latest` via the build stamp), so the first start after `down` is slower.

### Raw docker compose (power users)

Compose lives in the CLI cache dir (never in your repo) and interpolates the
bind mounts from env vars — unset `WORKSPACE_HOST_PATH`/`WORKSPACE_BARE_PATH`
are a hard error. The CLI injects a **per-repo compose project name** on every
invocation (the `name: cheasee-pi` in the file is a fallback only), so direct
usage must pass it too:

```bash
WORKSPACE_HOST_PATH=$(pwd) \
WORKSPACE_BARE_PATH=$(dirname "$(pwd)")/.bare \
  docker compose -p cheasee-pi-<repo-slug> \
    -f ~/.cache/cheasee-pi/<version>/docker-compose.yml up -d
```

## CodeFlow (code-structure visualization)

The stack includes a local CodeFlow service: a browser-based visualizer that renders
the workspace's module dependency graph, call structure, and architecture (tree-sitter
AST parsing, 18 languages). It starts automatically with `cheasee-pi start`.

The host port is **derived per repository** (8470 + a deterministic hash of the
repo identity, probed with a next-free fallback) so parallel workspaces never
collide on one port. `cheasee-pi start` prints the URL after starting:

```
ℹ CodeFlow: http://localhost:8891/?repo=local/workspace&run=1
```

Open the printed URL in the browser (the `repo` and `run` parameters trigger
analysis of the mounted workspace `/workspaces/main` without further
interaction; the `repo` value is arbitrary — the local shim ignores it and
maps every API request to the mounted repository).

To pin a port explicitly, set `docker.codeflowPort` in
`cheasee-settings.json`, or the `CODEFLOW_PORT` env var (env wins over
derivation, the settings file wins over the env).

### Configuration

Settings live in `codeflow/config.json` inside the CLI cache dir (bind-mounted
read-only, editable without rebuilding the image):

| Key | Default | Purpose |
| --- | --- | --- |
| `port` | `8470` | Container-side listen port; keep the compose mapping (`CODEFLOW_PORT:8470`) in sync when changed |
| `host` | `0.0.0.0` | Bind address; `127.0.0.1` restricts access to localhost |
| `exclude_dirs` | `[".git", "node_modules", "ignore"]` | Directory names skipped during the file walk |

Configuration changes take effect on the next container start (no rebuild
required). The compose port mapping uses `CODEFLOW_PORT` for the host side
(derived per repo by the CLI; `docker.codeflowPort` / `CODEFLOW_PORT`
override it).

### Limitations

GitHub-specific features (ownership attribution, pull-request impact analysis)
require the real GitHub API and are unavailable in local mode; the structure
graph, blast radius, and health score work fully offline.

## Run pi

### Using the CLI (auto)

```bash
cheasee-pi
```

`cheasee-pi` (no subcommand, alias `start`) gates on the workspace: empty
folder → auto-runs `cheasee-pi init` and continues into start in the same
invocation; `cheasee-settings.json` present → runs; non-empty folder without
settings → refused with a hint to run init. It then starts the container if
needed, reads `~/.config/cheasee-pi/auth.json`,
injects API keys as env vars, and launches pi with your repo mounted at
`/workspaces/main`.

### Using docker exec (native)

```bash
# The container is named cheasee-pi-<repo-slug> (repo slug, not plain cheasee-pi)
CONTAINER=$(docker ps --format '{{.Names}}' | grep '^cheasee-pi-')
docker exec -it --user agentuser -w /workspaces/main "$CONTAINER" /usr/bin/pi --approve
```

This runs the `pi` CLI inside the running container as `agentuser`, working in the
workspace directory.

**API key passthrough:** API keys set in the host shell are NOT automatically available
inside the container. Pass them explicitly with `-e`:

```bash
docker exec -it \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  --user agentuser \
  -w /workspaces/main \
  "$CONTAINER" /usr/bin/pi --approve
```

> **Tip:** For automatic API key injection from `~/.config/cheasee-pi/auth.json`, use
> `cheasee-pi start` instead.

## Parallel workspaces

Each workspace/repository gets its own container (`cheasee-pi-<repo-slug>`
plus the `codeflow-<repo-slug>` sidecar, and a per-repo compose project name)
— two different repos on one host run side by side without interfering.
Within one repo you can run multiple pi sessions against the same container
simultaneously from different terminals. Each `docker exec` creates an
independent process on the same container — they do not share a TUI or stdin.

```bash
# Terminal 1 (use the CONTAINER var from "Using docker exec" above)
docker exec -it --user agentuser -w /workspaces/main "$CONTAINER" /usr/bin/pi --approve

# Terminal 2 (same container, independent session)
docker exec -it --user agentuser -w /workspaces/main "$CONTAINER" /usr/bin/pi --approve
```

### Stale process cleanup

Pi processes can become orphaned if a `docker exec` session disconnects or the
wrapper is killed before cleanup runs. These accumulate RAM (150–280 MB each).

**Cleanup command:**

```bash
cheasee-pi clean
```

`clean` removes **every** cheasee-pi container on the host (all repositories,
running or stopped), running the orphan scan inside each first, then prunes
dangling images and build cache. **It force-removes running containers —
active pi sessions inside them are killed** (confirm first, or use `--yes`;
`--dry-run` previews; `--name <container>` scopes to a single container).

**Automatic pre-start cleanup:** `cheasee-pi start` / `cheasee-pi up` runs the
same orphan scan before launching pi, so orphans are always cleaned between
sessions.

## Stop

### Using the CLI (auto)

```bash
cheasee-pi down
```

`cheasee-pi down` (alias `cheasee-pi stop`) stops and removes the container of
the **current workspace only** via `docker compose down` (the compose project
name derives from the workspace's repository, so sibling workspaces' containers
keep running). Outside any workspace the identity derives from the folder
basename and `down` no-ops when nothing matches; legacy pre-derivation
containers (project `cheasee-pi`) are not targeted — `cheasee-pi clean`
removes those.

### Full teardown (removes container)

```bash
WORKSPACE_HOST_PATH=$(pwd) WORKSPACE_BARE_PATH=$(dirname "$(pwd)")/.bare \
  docker compose -p cheasee-pi-<repo-slug> \
    -f ~/.cache/cheasee-pi/<version>/docker-compose.yml down
```

This stops and **removes** the container. On next `up -d`, the container is rebuilt
from scratch, including `npm install` (~30-60s).

### Pause (preserves container state)

```bash
WORKSPACE_HOST_PATH=$(pwd) WORKSPACE_BARE_PATH=$(dirname "$(pwd)")/.bare \
  docker compose -p cheasee-pi-<repo-slug> \
    -f ~/.cache/cheasee-pi/<version>/docker-compose.yml stop
```

This stops the container but keeps it intact. Next `cheasee-pi start` (without
`--build`) restarts the existing container instantly. Use `docker compose stop` for
short breaks and `down` when you're done for the day.

> **Note:** `docker compose down` maps to `down` (not `stop`) to avoid name collision
> on the next `up` — `docker compose stop` preserves the container; `down` removes it.

## Rebuild after Dockerfile changes

When the embedded Dockerfile or any dependency changes, rebuild the image explicitly:

```bash
WORKSPACE_HOST_PATH=$(pwd) WORKSPACE_BARE_PATH=$(dirname "$(pwd)")/.bare \
  docker compose -p cheasee-pi-<repo-slug> \
    -f ~/.cache/cheasee-pi/<version>/docker-compose.yml build \
  && docker compose -p cheasee-pi-<repo-slug> \
    -f ~/.cache/cheasee-pi/<version>/docker-compose.yml up -d
```

Or rebuild and restart in one step with `--build`:

```bash
cheasee-pi start --build
```

**Why explicit build?** `docker compose up` without `--build` reuses the cached
image even if the Dockerfile changed. You must either run `docker compose build`
or pass `--build` to pick up changes.

**Build timing:** The first build takes ~2 min (Debian 12-slim + Node.js 22 + Python
3 + pi + dependencies). Subsequent builds take ~10-30s thanks to Docker layer caching.

### Full rebuild (ignore cache)

`cheasee-pi rebuild` performs a full no-cache rebuild plus prune: it ignores
every cached layer (`--no-cache`), pulls a fresh base image (`--pull`) and
prunes dangling images + build cache afterwards. Note the naming inversion vs
VS Code: cheasee-pi's `rebuild` is the no-cache variant, while `build` is the
cached rebuild.

```bash
# CLI
cheasee-pi rebuild

# Docker compose directly (same flags rebuild passes)
WORKSPACE_HOST_PATH=$(pwd) WORKSPACE_BARE_PATH=$(dirname "$(pwd)")/.bare \
  docker compose -p cheasee-pi-<repo-slug> \
    -f ~/.cache/cheasee-pi/<version>/docker-compose.yml build --no-cache --pull
```

rebuild = no-cache full rebuild + prune. `cheasee-pi build --no-cache` is kept
as a compatibility alias (same rebuild, but prunes before the build and does
not pass `--pull`). Use `rebuild` when:
- Base image (`debian:12-slim`) has security updates — `rebuild`'s `--pull`
  refreshes it; `--no-cache` alone would keep the locally cached base image
- `apt` or `pip` packages need fresh versions
- You suspect cache corruption
- You want to verify the Dockerfile is reproducible

## Troubleshooting

### Bind-mount permission errors

**Symptom:** `Permission denied` when reading/writing files in the workspace inside the
container.

**Cause:** The UID/GID inside the container (default `agentuser`) doesn't match the host
user's UID/GID. The entrypoint auto-detects from `/workspaces/main`, but on macOS
(OrbStack) and Windows (WSL2), the mount owner may not match your host user.

**Fix:** Pass `HOST_UID` and `HOST_GID` explicitly:

```bash
WORKSPACE_HOST_PATH=$(pwd) WORKSPACE_BARE_PATH=$(dirname "$(pwd)")/.bare \
  HOST_UID=$(id -u) HOST_GID=$(id -g) \
  docker compose -p cheasee-pi-<repo-slug> \
    -f ~/.cache/cheasee-pi/<version>/docker-compose.yml up -d
```

### Missing API keys

**Symptom:** Inside the container, `echo $ANTHROPIC_API_KEY` returns empty, and pi
complains about missing credentials.

**Cause:** Environment variables set in the host shell are not passed into the container
unless explicitly forwarded via `docker exec -e`.

**Fix:** Use `cheasee-pi start` which reads API keys from
`~/.config/cheasee-pi/auth.json` and forwards them, or pass each key explicitly:

```bash
CONTAINER=$(docker ps --format '{{.Names}}' | grep '^cheasee-pi-')
docker exec -it -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  --user agentuser -w /workspaces/main "$CONTAINER" /usr/bin/pi --approve
```

### Stale pi/orphaned processes

**Symptom:** After several parallel sessions, running `pi` shows unexpected behavior or
errors about existing sessions.

**Cause:** Pi processes from disconnected/crashed sessions remain running. These can
interfere with new sessions.

**Fix:** Run the stale-process cleanup (see [Parallel sessions](#stale-process-cleanup)).

### Container doesn't start

**Symptom:** `docker compose up -d` exits with an error.

**Causes and fixes:**

1. **Port conflict:** The CodeFlow host port is derived per repo (8470 +
   deterministic hash, next-free fallback) — two parallel workspaces normally
get distinct ports. A custom `docker.codeflowPort` / `CODEFLOW_PORT` that
collides with another service still fails "port is already allocated"; check
with `docker ps` and pick a free port.
2. **Corrupt image:** Rebuild without cache:
   ```bash
   cheasee-pi rebuild
   cheasee-pi start
   ```
   (raw compose equivalent: `docker compose ... build --no-cache --pull`)
3. **Docker not running:** Verify with `docker ps`.

### GitHub auth not working inside container

**Symptom:** `gh auth status` inside the container shows `not logged in`.

**Fix:** Ensure `gh auth login -s repo,project,workflow` has been run on the host.
The container mounts `~/.config/gh/` read-write automatically.
