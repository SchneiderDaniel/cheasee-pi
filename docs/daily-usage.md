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
  `cheasee-pi start` in an empty folder — it auto-runs init and stops (init
  never launches pi); run `cheasee-pi start` again to start pi. Re-authenticate
  later (revoked GitHub token, rotated API keys) with `cheasee-pi init --reauth`
  in the workspace — it redoes the GitHub OAuth and pi API-key authentications.

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

This builds the Docker image from the CLI cache dir (`~/.cache/cheasee-pi/<version>/`;
the first build downloads ~1GB of build-time dependencies and can take several
minutes on slower connections) and starts the container in detached mode. The container runs
`sleep infinity` and stays alive until you stop it.

**What happens:**
- Compose/Dockerfile are extracted to the CLI cache dir; the image clones
  cheasee-pi's own repository (github.com/SchneiderDaniel/cheasee-pi,
  `ARG CHEASEE_REF`, default `main`) into `/opt/cheasee-pi` and symlinks its
  resources into `~/.pi/agent/` — not your repo
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
repo identity, probed with a next-free fallback; the range is 8470–9493) so
parallel workspaces never collide on one port. `cheasee-pi start` prints the
URL after starting:

```
ℹ CodeFlow: http://localhost:8891/?repo=local/workspace&run=1
ℹ Optional browser sidecar — see docs/daily-usage.md §CodeFlow
```

Each session start *also* posts the same URL as a clickable hyperlink inside
pi, right below the existing startup hint (terminals without OSC 8 hyperlink
support see the plain URL text):

```
For Info:  /cheasee-pi-info
CodeFlow:  http://localhost:8891/?repo=local/workspace&run=1
```

Open the printed URL in the browser (the `repo` and `run` parameters trigger
analysis of the mounted workspace `/workspaces/main` without further
interaction; the shim ignores the `repo` name and maps every API request to
the mounted repository, but appends a short workspace-content fingerprint to
it on the entrypoint redirect, so the browser re-analyzes when the workspace
changes and reuses the cached result when it does not).

What gets analyzed is the repository's **git-tracked files** — the same set
GitHub serves. Untracked workspace artifacts (the `.pi/git` package clones,
the python virtualenvs under `.pi/`, session logs) stay out of the graph even
when the repository's own `.gitignore` does not list them. Uncommitted edits
to tracked files are read as-is; a brand-new file appears once it is staged.

To pin a port explicitly, set `docker.codeflowPort` in
`cheasee-settings.json`, or the `CODEFLOW_PORT` env var (env wins over
derivation, the settings file wins over the env).

The sidecar's host-side port is pinned to **loopback only** by default: the
compose mapping binds `127.0.0.1:<port>` on the host, so the printed
`http://localhost:<port>/...` URL matches the actual reachability and the
workspace source the sidecar serves is not routable off-host. Remote access
is an explicit opt-in: start with `CODEFLOW_HOST_IP=0.0.0.0` (e.g.
`CODEFLOW_HOST_IP=0.0.0.0 cheasee-pi start`) — that exposes the
unauthenticated sidecar to your whole network, so prefer an authenticated
tunnel (Tailscale Serve, `cloudflared tunnel --url
http://localhost:<port>`) when sharing with specific peers.

### Configuration

Settings live in `codeflow/config.json` inside the CLI cache dir (bind-mounted
read-only, editable without rebuilding the image):

| Key | Default | Purpose |
| --- | --- | --- |
| `port` | `8470` | Container-side listen port; keep the compose mapping (`CODEFLOW_PORT:8470`) in sync when changed |
| `host` | `0.0.0.0` | **Container-side** bind address — must stay `0.0.0.0` (docker-proxy/DNAT delivers published traffic to it); host-side reachability is the compose mapping's `CODEFLOW_HOST_IP` job, below |
| `exclude_dirs` | `[".git", "node_modules", "ignore"]` | Directory names excluded from the served tracked set |

Configuration changes take effect on the next container start (no rebuild
required). The compose port mapping uses `CODEFLOW_PORT` for the host side
(derived per repo by the CLI; `docker.codeflowPort` / `CODEFLOW_PORT`
override it) and pins the host-side bind to loopback (`CODEFLOW_HOST_IP`,
default `127.0.0.1`).

### Limitations

GitHub-specific features (ownership attribution, pull-request impact analysis)
require the real GitHub API and are unavailable in local mode; the structure
graph, blast radius, and health score work fully offline. The local shim treats
`.mts` and `.cts` files as TypeScript, so the NodeNext ESM/CJS extensions
appear in the file tree, language breakdown, and dependency graph like `.ts`.

## UI (web control center)

The stack also includes a local `ui` service: the cheasee-pi web control
center. It serves the browser control center on `GET /` and a WebSocket RPC
relay on `/ws` for listing, attaching to, and stopping pi sessions. It starts
automatically with `cheasee-pi start`, which prints:

```
ℹ UI: http://127.0.0.1:9713
```

The host port is **derived per repository** in the band 9500–10523 (9500 + a
deterministic hash of the repo identity, probed with a next-free fallback),
disjoint from the CodeFlow band so the two sidecars of one workspace never
collide.

The host side is **bound to loopback** (`127.0.0.1`) by configuration — there is
no all-interfaces opt-in. This is a reachability default, not a hard isolation
boundary: Docker Engine before 28.0.0 may expose a loopback-published port to
hosts on the same L2 segment, and this project accepts Engine 24.0.0 and later
(see [Security](security.md); hardening is tracked under #1527). The URL is
printed with the literal `127.0.0.1` rather than `localhost` so it matches the
published IPv4 loopback bind on every host.

To pin a port explicitly, set `docker.uiPort` in `cheasee-settings.json`, or
the `PI_UI_PORT` env var (env wins over derivation, the settings file wins
over the env).

The host port the running sidecar actually published is forwarded into the pi
session as `PI_UI_PORT` (bound-first, alongside the CodeFlow sidecar's
`CODEFLOW_PORT`), so the in-session footer link always agrees with the printed
`ℹ UI:` hint even when a stale `docker.uiPort` differs from the live bind. When
the host port cannot be resolved (range exhausted) the CLI omits `PI_UI_PORT`
(never a bare `PI_UI_PORT=`) and sets the separate failure marker
`CHEASEE_UI_PORT_UNRESOLVED=1`; the footer reads the marker and suppresses the
`UI` link rather than deriving an occupied port that belongs to another
workspace, while the start still succeeds. A session started outside the CLI
(no forwarded variable and no marker) keeps the settings/derived fallback.

The session footer row 3 shows a right-aligned `UI · CodeFlow` link group. Each
label is an unconditional OSC 8 hyperlink to its URL — no capability probe,
same policy as the supervisor issue link on row 4, because the in-container
probe reports `hyperlinks:false` under `TERM=xterm` (Docker) even when the
host terminal supports the sequence; a host terminal that swallows OSC 8
renders the label as plain text. The sequence goes straight to the session
PTY, i.e. the **host
terminal**, which is the click handler and opens the URL in the host browser
with its usual click/modifier (iTerm2 cmd-click, WezTerm plain click, kitty
Ctrl-Shift-click). The installed pi-tui (0.79.10) does not enable SGR mouse
tracking and has no OSC 8 click routing, so pi does not intercept the click and
cannot shadow that host opener. The URLs are host-loopback addresses
(`127.0.0.1` / `localhost`); they are display strings only — never pinged or
opened inside the container, where host loopback is a different network
namespace. A port that is not a decimal in 1–65535 is rejected before it
reaches the sequence, so a hand-edited settings or env payload cannot inject
terminal control characters. On a terminal too narrow to fit both the left
session/trust content and the group, the group is kept and the left content is
truncated first.

### Starting and reconnecting

Start (or restart) the sidecar together with the agent:

```bash
cheasee-pi start
```

Open the printed `ℹ UI:` URL in a browser to reach the control center. To
reconnect after closing the tab, reopen the same URL — the sidecar keeps running
(compose `restart: unless-stopped`) and the session list is read from the shared
workspace mount, so a running pi session reappears without a restart. Stopping
the stack with `cheasee-pi down` stops the sidecar too.

The sidecar binds **all container interfaces** at `0.0.0.0:3000` (required for
docker-proxy/DNAT to deliver the published port); the *host* side is bound to
`127.0.0.1:<port>` by the compose mapping.

### Terminal + UI coexistence (in-use guard)

A terminal session and the UI can drive the same workspace at once, but only one
process may *attach* to a given session. `cheasee-pi start` publishes a
live-session claim at `.pi/sessions/.cheasee-inuse/<sessionId>` on the shared
workspace mount; the UI relay reads that claim and refuses a second attach with:

```
session <id> is in use by another process — fork or clone instead
```

The claim is dropped when the CLI session exits. To work in parallel, fork or
clone the session from the UI instead of attaching.

## Run pi

### Using the CLI (auto)

```bash
cheasee-pi
```

`cheasee-pi` (no subcommand, alias `start`) gates on the workspace: empty
folder → auto-runs `cheasee-pi init` and stops (init never launches pi —
run `cheasee-pi start` again to start); `cheasee-settings.json` present →
runs; non-empty folder without settings → refused with a hint to run init in
an empty folder. On an initialized workspace it starts the container if
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

`clean` only prunes garbage — the tagged per-repo images (several GB each)
stay. **Disk full?** Run `cheasee-pi prune-images` after `clean`: it removes
every tagged `cheasee-pi-*` image on the host and reclaims the build cache
they pin.

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

**Build timing:** The first build downloads ~1GB of build-time dependencies
(Debian 12-slim + Node.js 22 + Python 3 + pi + dependencies) and can take
several minutes on slower connections. Subsequent builds take ~10-30s thanks to Docker layer caching.

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

rebuild = no-cache full rebuild + prune. Use `rebuild` when:
- Base image (`debian:12-slim`) has security updates — `rebuild`'s `--pull`
  refreshes it; `--no-cache` alone would keep the locally cached base image
- `apt` or `pip` packages need fresh versions
- You suspect cache corruption
- You want to verify the Dockerfile is reproducible

### Freeing disk space

Repeated `build`/`rebuild` runs leave one tagged image per repository
(`cheasee-pi-<repo-slug>-<service>`, several GB each), and `clean` never
removes them — the Docker data root (`/var`) fills up over time. Reclaim the
space in two steps:

```bash
cheasee-pi clean            # remove containers first (prune-images refuses while any exist)
cheasee-pi prune-images     # remove ALL tagged cheasee-pi-* images + the build cache they pin
```

`clean` removes containers; `prune-images` is the explicit disk-reclaim step.
It removes every tagged cheasee-pi image on the host (all repositories, no
keep-latest — images are regenerated by the next `build`/`rebuild`), then
prunes the build cache the images pinned. It runs `docker buildx prune -a`,
which also discards other projects' cache on the shared builder. `--dry-run`
previews the reclaimable images, `--yes` skips the confirmation.

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
with `docker ps` and pick a free port. The UI host port is derived the same
way (9500 + hash, band 9500–10523); pin it with `docker.uiPort` / `PI_UI_PORT`
if it collides.
2. **Corrupt image:** Rebuild without cache:
   ```bash
   cheasee-pi rebuild
   cheasee-pi start
   ```
   (raw compose equivalent: `docker compose ... build --no-cache --pull`)
3. **Docker not running:** Verify with `docker ps`.

### GitHub auth not working inside container

**Symptom:** `gh auth status` inside the container shows `not logged in`.

**Fix:** Ensure `gh auth login -s repo,read:org,project,workflow` has been run on the host.
The container mounts `~/.config/gh/` read-write automatically.

### Workflow-file pushes rejected

**Symptom:** a push touching `.github/workflows/*` is rejected with
`refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`.

**Cause:** tokens minted before the `workflow` scope was added to the OAuth request list
carry only `repo, read:org, project` — and `repo` does not cover workflow files.

**Fix:** tokens minted by a fresh `cheasee-pi init` / `cheasee-pi init --reauth` request
`repo, read:org, project, workflow`. To upgrade an existing token, re-run
`cheasee-pi init --reauth` in the workspace: it redoes the device flow with the widened
scope list and rewrites `~/.config/cheasee-pi/auth.json`, which is the source the
container actually consumes (`entrypoint.sh` re-imports it into `gh`, and `up` exports
it as `GH_TOKEN`). A bare host-side `gh auth refresh -h github.com -s workflow` upgrades
only gh's credential store — the container overrides that on its next start, so it does
not durably fix the pipeline.
