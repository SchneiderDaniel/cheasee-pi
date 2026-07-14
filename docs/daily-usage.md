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
- Workspace root is bind-mounted to `/workspaces` inside the container
- Entrypoint auto-detects UID/GID from the mount and remaps the `agentuser` user
- npm dependencies are installed on first start (~30-60s)

### Subsequent starts

```bash
docker compose -f docker/docker-compose.yml up -d
```

Without `--build`, Compose reuses the cached image — start is near-instant (~2s).

### Using the convenience script

```bash
bash docker/run-pi.sh
```

`run-pi.sh` checks if the container is running, starts it if needed, then execs into it.
It also reads `~/.pi/agent/auth.json` and passes API keys as environment variables
(see [Missing API keys](#missing-api-keys) in Troubleshooting).

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

> **Tip:** For automatic API key injection from `~/.pi/agent/auth.json`, use the
> [convenience script](#using-the-convenience-script) instead.

### Using the convenience script

```bash
bash docker/run-pi.sh
```

This combines start and exec into a single idempotent command — it starts the container
if not running, injects API keys from `~/.pi/agent/auth.json`, and opens the pi TUI.

### Using the legacy wrapper

```bash
./cheasee-pi.sh
```

The `cheasee-pi.sh` wrapper is the original way to run pi. It handles image builds,
container start, environment passthrough, and stale-process cleanup automatically.
Run `./cheasee-pi.sh --help` for all options.

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

Pi processes can become orphaned if a session crashes or the network disconnects.
These accumulate across parallel sessions. As an optional but recommended cleanup:

```bash
docker exec cheasee-pi bash -c \
  'for f in /tmp/pi-active-*; do
     [ -f "$f" ] && pid=$(cat "$f") && ! kill -0 "$pid" 2>/dev/null && rm -f "$f";
   done'
```

The `cheasee-pi.sh` wrapper handles this automatically via its built-in
`kill_stale_pi_host` function.

## Stop

### Full teardown (removes container)

```bash
docker compose -f docker/docker-compose.yml down
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

### Using the convenience script

```bash
bash docker/stop-pi.sh
```

This runs `docker compose down` — the standard full teardown.

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

> Tip: The legacy `./cheasee-pi.sh --rebuild` command handles this automatically.

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

**Fix:** Use the convenience script (`bash docker/run-pi.sh`) which reads API keys from
`~/.pi/agent/auth.json` and forwards them, or pass each key explicitly:

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
Or use `./cheasee-pi.sh` which handles this automatically.

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

## Legacy: cheasee-pi.sh

The `./cheasee-pi.sh` wrapper provides the original all-in-one experience:

- Builds and starts the container
- Auto-injects API keys from `~/.pi/agent/auth.json`
- Handles stale-process cleanup
- Rebuilds on dependency changes (`--rebuild` flag)
- Attach mode for parallel sessions (`--attach` flag)

Run `./cheasee-pi.sh --help` for full usage. The wrapper source at `cheasee-pi.sh`
documents its internals if you need to understand the implementation.
