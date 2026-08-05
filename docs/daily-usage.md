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

Before running pi via Docker, ensure the following are in place:

- **Docker Engine** running with Compose V2 (verified by `docker compose version`)
- **GitHub CLI authenticated** on the host — `gh auth status` shows `Logged in to github.com`
- **Emoji font** on the host terminal (see [Installation > Troubleshooting](installation.md#emoji--icons-not-displaying) for setup)
- **First-time build complete** — the Docker image must be built at least once. See [Start](#start-the-container) below.

The container mounts `~/.config/gh/` read-write, so host GitHub authentication works
automatically inside the container.

> **Note about UID/GID:** The entrypoint auto-detects `HOST_UID` and `HOST_GID` from the
> `/workspaces/main` mount ownership. On macOS (OrbStack) and Windows (WSL2), bind-mount
> permissions may differ — if you encounter permission errors, pass them explicitly:
> ```bash
> HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f docker/docker-compose.yml up -d
> ```

## Start the container

### First run (build + start)

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

This builds the Docker image from `docker/Dockerfile` (~2 min first time) and starts
the container in detached mode. The container runs `sleep infinity` and stays alive
until you stop it.

**What happens:**
- Image is built from `docker/Dockerfile` (Debian 12-slim + Node.js 22 + Python 3 + pi)
- CodeFlow service image is built from `docker/codeflow/Dockerfile` (first run clones the CodeFlow UI)
- Workspace root is bind-mounted to `/workspaces` inside the container
- Entrypoint auto-detects UID/GID from the mount and remaps the `agentuser` user
- npm dependencies are installed on first start (~30-60s)

### Subsequent starts

```bash
docker compose -f docker/docker-compose.yml up -d
```

Without `--build`, Compose reuses the cached image — start is near-instant (~2s).

### Using the CLI (auto)

```bash
cheasee-pi
```

`cheasee-pi` (no subcommand) checks if the container is running, starts it if needed,
reads `~/.config/cheasee-pi/auth.json`, injects API keys as env vars, and launches pi.
`cheasee-pi start` and `cheasee-pi up` work as aliases.

For a shell-based alternative, see `docker/run-pi.sh`.

See [Missing API keys](#missing-api-keys) in Troubleshooting if models still don't
show up.

## CodeFlow (code-structure visualization)

The stack includes a local CodeFlow service: a browser-based visualizer that renders
the workspace's module dependency graph, call structure, and architecture (tree-sitter
AST parsing, 18 languages). It starts automatically with `docker compose up -d` and
serves on port 8470.

Open it in the browser:

```
http://localhost:8470/?repo=local/workspace&run=1
```

The `repo` and `run` parameters trigger analysis of the mounted workspace
(`/workspaces/main`) without further interaction. The `repo` value is arbitrary
(`owner/name`); the local shim ignores it and maps every API request to the
mounted repository, including git submodule directories when enabled.

### Configuration

Settings live in `docker/codeflow/config.json` (bind-mounted read-only, editable
without rebuilding the image):

| Key | Default | Purpose |
| --- | --- | --- |
| `port` | `8470` | Listen port; keep the compose mapping (`CODEFLOW_PORT:8470`) in sync when changed |
| `host` | `0.0.0.0` | Bind address; `127.0.0.1` restricts access to localhost |
| `include_submodules` | `false` | When `true`, git submodules (`private-pi`, `flask_blogs`) are included in the analysis |
| `exclude_dirs` | `[".git", "node_modules", "ignore"]` | Directory names skipped during the file walk |

Configuration changes take effect on the next `docker compose up -d` (no rebuild
required). The compose port mapping uses `CODEFLOW_PORT` for the host side.

### Limitations

GitHub-specific features (ownership attribution, pull-request impact analysis)
require the real GitHub API and are unavailable in local mode; the structure
graph, blast radius, and health score work fully offline.

## Run pi

### Using docker exec (native)

```bash
docker exec -it --user agentuser -w /workspaces/main cheasee-pi pi
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
  cheasee-pi pi
```

> **Tip:** For automatic API key injection from `~/.config/cheasee-pi/auth.json`, use
> `cheasee-pi start` instead.

### Using `cheasee-pi` (no subcommand)

```bash
cheasee-pi
```

`cheasee-pi` combines start and exec into a single command — it starts the container
if not running, injects API keys from `~/.config/cheasee-pi/auth.json`, and opens the pi TUI.
`cheasee-pi start` and `cheasee-pi up` work as aliases.

## Parallel sessions

You can run multiple pi sessions against the same container simultaneously from
different terminals. Each `docker exec` creates an independent process on the same
container — they do not share a TUI or stdin.

```bash
# Terminal 1
docker exec -it --user agentuser -w /workspaces/main cheasee-pi pi

# Terminal 2 (same container, independent session)
docker exec -it --user agentuser -w /workspaces/main cheasee-pi pi
```

### Stale process cleanup

Pi processes can become orphaned if a `docker exec` session disconnects or the
wrapper is killed before cleanup runs. These accumulate RAM (150–280 MB each).

**Cleanup command:**

```bash
cheasee-pi clean
```

This scans for processes reparented to PID 1 and kills them. It only targets
orphans — interactive sessions are **not** affected.

**Automatic pre-start cleanup:** `cheasee-pi start` / `cheasee-pi up` runs the
same orphan scan before launching pi, so orphans are always cleaned between
sessions.

## Stop

### Using the CLI (auto)

```bash
cheasee-pi down
```

`cheasee-pi down` (alias `cheasee-pi stop`) stops and removes the container via
`docker compose down`.

### Full teardown (removes container)

```bash
docker compose -f docker/docker-compose.yml down
```

Or use the convenience script:

```bash
bash docker/stop-pi.sh
```

This stops and **removes** the container. On next `up -d`, the container is rebuilt
from scratch, including `npm install` (~30-60s).

### Pause (preserves container state)

```bash
docker compose -f docker/docker-compose.yml stop
```

This stops the container but keeps it intact. Next `docker compose up -d` (without
`--build`) restarts the existing container instantly. Use `docker compose stop` for
short breaks and `down` when you're done for the day.

> **Note:** `docker compose down` maps to `down` (not `stop`) to avoid name collision
> on the next `up` — `docker compose stop` preserves the container; `down` removes it.

## Rebuild after Dockerfile changes

When `docker/Dockerfile` or any dependency changes, rebuild the image explicitly:

```bash
docker compose -f docker/docker-compose.yml build && docker compose -f docker/docker-compose.yml up -d
```

Or rebuild and restart in one step with `--build`:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

**Why explicit build?** `docker compose up` without `--build` reuses the cached
image even if the Dockerfile changed. You must either run `docker compose build`
or pass `--build` to pick up changes.

**Build timing:** The first build takes ~2 min (Debian 12-slim + Node.js 22 + Python
3 + pi + dependencies). Subsequent builds take ~10-30s thanks to Docker layer caching.

### Full rebuild (ignore cache)

When Docker layer cache is stale or you want a clean build from scratch:

```bash
# CLI
cheasee-pi build --no-cache

# Docker compose directly
docker compose -f docker/docker-compose.yml build --no-cache
```

This ignores all cached layers and rebuilds every step. Use when:
- Base image (`debian:12-slim`) has security updates
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
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f docker/docker-compose.yml up -d
```

### Missing API keys

**Symptom:** Inside the container, `echo $ANTHROPIC_API_KEY` returns empty, and pi
complains about missing credentials.

**Cause:** Environment variables set in the host shell are not passed into the container
unless explicitly forwarded via `docker exec -e`.

**Fix:** Use `cheasee-pi start` which reads API keys from
`~/.config/cheasee-pi/auth.json` and forwards them, or pass each key explicitly:

```bash
docker exec -it -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  --user agentuser -w /workspaces/main cheasee-pi pi
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

1. **Port conflict:** No port mapping is configured by default, but custom overrides in
   `docker-compose.override.yml` may conflict. Check with `docker compose ps`.
2. **Corrupt image:** Rebuild without cache:
   ```bash
   docker compose -f docker/docker-compose.yml build --no-cache
   docker compose -f docker/docker-compose.yml up -d
   ```
3. **Docker not running:** Verify with `docker ps`.

### GitHub auth not working inside container

**Symptom:** `gh auth status` inside the container shows `not logged in`.

**Fix:** Ensure `gh auth login -s repo,project,workflow` has been run on the host.
The container mounts `~/.config/gh/` read-write automatically.


