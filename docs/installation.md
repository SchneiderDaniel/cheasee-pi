---
layout: default
title: Installation
nav_order: 2
---

# Installation

{: .no_toc }

1. TOC
   {:toc}

## Prerequisites

- **Docker Engine** ≥24.0 with [Compose V2](https://docs.docker.com/compose/)
- **Free disk space** — at least **10 GiB** free on the Docker data root
  (`docker info --format '{{.DockerRootDir}}'`, usually `/var/lib/docker`).
  All image layers, the build cache and the export scratch land there.
  `cheasee-pi build` and `cheasee-pi start` refuse to build below that
  threshold; reclaim space with `cheasee-pi clean` and
  `cheasee-pi prune-images`.
- **git** with `user.name` and `user.email` configured
- **Your own git repository** — cheasee-pi runs from any repo you own (it does not clone/fork anything)

## Install

### Linux / macOS

```bash
curl -fsL https://raw.githubusercontent.com/SchneiderDaniel/cheasee-pi/main/scripts/install.sh | bash
```

Installs to `~/.local/bin` (the single canonical location — no sudo needed).
If `~/.local/bin` is not on your PATH, add it to your shell config:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

{:.note-title}

> macOS
> Gatekeeper may block the unsigned binary. Run `xattr -d com.apple.quarantine ~/.local/bin/cheasee-pi` or Ctrl-click → Open in Finder.

### Windows

```powershell
# PowerShell
$version = "0.67.0"
$arch = if ((Get-CimInstance Win32_ComputerSystem).SystemType -match "ARM") { "arm64" } else { "amd64" }
curl -Lo cheasee-pi.zip "https://github.com/SchneiderDaniel/cheasee-pi/releases/download/v$version/cheasee-pi_${version}_windows_$arch.zip"
tar -xf cheasee-pi.zip
Move-Item cheasee-pi.exe "$env:LOCALAPPDATA\cheasee-pi\"
# Add to PATH manually: https://gist.github.com/nex3/c395b2f8fd4b020168be
```

### Verify

```bash
cheasee-pi --version
```

## Setup

> Full command reference — what every command does, checks, and needs as input:
> [CLI Reference](cli.md). Workspace settings and credential storage are
> described in the [Configuration reference](configuration.md).

```bash
cheasee-pi init
```

Run init in an **empty folder** — cheasee-pi sets the workspace up itself:

1. Verifies Docker Engine 24.0+ is installed and running
2. Probes the folder — init is empty-folder-only (existing non-empty folders
   are refused; cheasee-pi never auto-initializes them)
3. Asks for your project repo URL (`owner/repo` or any GitHub URL)
4. Authenticates with GitHub (OAuth device flow — code shown in the terminal, browser opens)
5. Bare-clones your repo to `<parent>/.bare` and adds the main worktree into
   the folder
6. Scaffolds the dedicated `cheasee-settings.json` at the folder root
   (gitignored, machine-local — docker memory/cpus, git identity, default
   provider; never overwrites an existing file)
7. Asks for custom skills (reusable instruction sets for pi) to install
   into the container — entered skill repository specs are recorded in
   `cheasee-settings.json` (`skillRepos`) and installed on first
   `cheasee-pi start` via pi (`pi install -l`, cloned to `.pi/git/`,
   reconcilable with `pi update`). No skill repository is installed by
   default: the list starts empty. To remove a recorded repo, delete it from
   `skillRepos` in `cheasee-settings.json` **and** run `pi uninstall <name>`
   inside the container — the clone stays in `.pi/git/` otherwise.

No docker files in your repo — the compose file and Dockerfile are CLI-managed
cache state, and pi's own `.pi/settings.json` is self-scaffolded by pi on its
first run.

{:.note-title}

> Custom skills?
> `cheasee-pi init --skill-repo owner/repo` records custom skills (git-hosted
> skill repository specs) without a prompt (repeatable; also accepts
> `https://…` or `git:host/user/repo[@ref]`). Recorded skill repos are
> installed into the container on `cheasee-pi start` via pi (`pi install -l`,
> project-local clones in `.pi/git/`, kept reconcilable with `pi update`). No
> skill repository is preinstalled — only what you record is installed.

{:.note-title}

> Upgrading from a release that shipped the Ponytail mode?
> A workspace set up by an earlier release may still record the
> `ponytail` package in its own `.pi/settings.json` (or `skillRepos` in
> `cheasee-settings.json`), and pi installs whatever an entry records. Nothing
> in the harness loads or refreshes that entry any more, so delete it once —
> and run `pi uninstall ponytail` inside the container to drop the clone —
> if you want it gone from an existing workspace. New workspaces start clean,
> and no user-level file is touched by the upgrade itself.

{:.note-title}

> No GitHub?
> `cheasee-pi init --no-github` skips auth and the clone; you provide API keys
> separately. `--no-input` needs `--repo-url <url>` since there is no prompt.

{:.note-title}

> Already initialized?
> `cheasee-pi init --reauth` re-runs the authentications (GitHub OAuth device
> flow + provider API-key setup) without touching the clone or the settings
> scaffold. Plain `cheasee-pi init` still refuses an initialized workspace —
> `--reauth` is the explicit redo entry point.

### Add API keys later

```bash
cheasee-pi auth add opencode-go    # pick your provider
cheasee-pi auth list                # verify
cheasee-pi auth remove <provider>   # drop a key
```

## Run

Run cheasee-pi from your **cheasee-pi workspace** — or straight from an empty
folder, which auto-runs init first:

```bash
# ✓ Auth config saved to the OS user config directory after init
cheasee-pi start
```

`cheasee-pi` (alias `start`) gates on the workspace state:

- **Empty folder** → auto-runs `cheasee-pi init` (repo URL prompt, bare clone
  - main worktree, `cheasee-settings.json`), then stops — init never launches
    pi; run `cheasee-pi start` again to start
- **`cheasee-settings.json` present** → initialized workspace; runs normally
- **Non-empty folder without `cheasee-settings.json`** → refused with
  “not initialized; run `cheasee-pi init` in an empty folder”

On an initialized workspace it:

1. Extracts the compose stack (Dockerfile, entrypoint, codeflow service) to
   the CLI cache dir (`~/.cache/cheasee-pi/<version>/`); the image build
   clones cheasee-pi's own repository (github.com/SchneiderDaniel/cheasee-pi,
   Dockerfile `ARG CHEASEE_REF`, default `main`) into `/opt/cheasee-pi` and
   symlinks its resources into `~/.pi/agent/` — not your repo. The CLI
   resolves that ref's upstream commit on every build and supplies it as
   `CHEASEE_COMMIT`, so the clone layer is re-run whenever upstream moves and
   stays cached when it has not; the baked commit is recorded at
   `/opt/cheasee-pi/BUILD_COMMIT`
2. Starts the container (first build downloads ~1GB of build-time
   dependencies; can take several minutes on slower connections) with the
   workspace
   mounted at `/workspaces/main` and its sibling bare repo at
   `/workspaces/.bare` (the entrypoint rewrites worktree paths and locks them)
3. Injects keys from `~/.config/cheasee-pi/auth.json` and opens pi TUI

### Global operating instructions

The cheasee-pi **operating instructions** — system role, tool-routing matrix,
prohibited operations, execution protocols, package-safety audit — live in
`APPEND_SYSTEM.md` at the cheasee-pi repo root. The image symlinks it into
`~/.pi/agent/APPEND_SYSTEM.md`, pi's global system-prompt append, so the
instructions are present in **every** repository the CLI runs in (not just
cheasee-pi workspaces). The repo-root `AGENTS.md` is a stub holding only
cheasee-pi-repo-specific policy plus a pointer to the global file.

In cheasee-pi workspaces the entrypoint re-points the global symlink at the
live mounted repo file, so edits are live; in other repos the baked image
copy is used (refreshed on image rebuild).

#### Baked clone refresh policy

The baked `/opt/cheasee-pi` copy is refreshed **deliberately**, not only when
Docker happens to evict the build cache. Every `cheasee-pi build` / `start`
resolves the upstream commit of `CHEASEE_REF` (`git ls-remote`) and passes it
to the clone layer as the `CHEASEE_COMMIT` build ARG, so the layer re-runs
exactly when that commit changes and stays cached (keeping the expensive
clone + `npm ci` off the critical path of a pi-only rebuild) when it does not.
If upstream is unreachable the probe warns and the CLI reuses the last
successfully baked commit **of the same `CHEASEE_REF`** (recorded per
workspace image in `~/.cache/cheasee-pi/<version>/`), so the cache key is
unchanged and the cached layer is still used — an offline rebuild does not
force a network clone. A commit recorded for a _different_ ref or a
_different_ workspace image is never reused: the cache key must describe the
ref actually being built. A first build with no record for the current ref
leaves the ARG empty; the build then reads the commit the image itself baked
(`/opt/cheasee-pi/BUILD_COMMIT`) back into the host record after it succeeds,
so `cheasee-pi about` still reports the truth. Should `CHEASEE_REF` move
between the probe and the clone, the clone layer fails the build instead of
caching the clone under the wrong commit's key; re-run the build.

The commit baked into the running image is recorded at
`/opt/cheasee-pi/BUILD_COMMIT` and printed by `cheasee-pi about` for the
workspace you run it in (one record per workspace image, so a build in another
workspace cannot mask a stale copy here), so a stale copy is visible rather
than silent: when the clone layer next re-runs, the build is guaranteed to have
baked exactly the commit `about` reports. To force a refresh regardless of
upstream movement, run `cheasee-pi rebuild` (no-cache).

Pi is installed at image build time pinned to a released version (currently
`1.0.2`, matching the Dockerfile and compose defaults). A plain
`cheasee-pi start` never rebuilds: it starts existing containers and only
builds an image that is absent. Use `cheasee-pi build` (or
`cheasee-pi start --build`) to re-resolve that pinned version. To track the
floating npm latest instead, opt in explicitly:
`PI_VERSION=latest cheasee-pi start --build`.

Stop the container when done:

```bash
cheasee-pi down
```

## After setup

Edit `cheasee-settings.json` in your workspace root to configure cheasee-pi:
`defaultProvider`, `defaultModel`, `docker.memory`/`docker.cpus`, `gitIdentity`.
Pi's own `.pi/settings.json` (`skills`, `prompts`, `extensions`,
`theme`) is self-scaffolded by pi on first run — the CLI never writes it.
`cheasee-pi auth add`/`auth list` round-trip the default provider/model
through `cheasee-settings.json`.

## What's next

- [Daily Usage](daily-usage.md) — parallel sessions, workflows, troubleshooting
- [Zed](https://zed.dev/) — recommend for the workspace: `zed .`

## Troubleshooting

### Build fails: not enough free space on the Docker data root

A build needs at least **10 GiB** free on the Docker data root
(`docker info --format '{{.DockerRootDir}}'`, usually `/var/lib/docker`).
Below that, `cheasee-pi build` / `start` stop before BuildKit writes anything
and name the reclaim commands:

```bash
cheasee-pi clean          # remove cheasee-pi containers
cheasee-pi prune-images   # remove the regenerable cheasee-pi images + build cache
cheasee-pi build          # retry
```

Do not let the partition fill up: if a build runs out mid-export, the Docker
daemon reclaims space on its own and can delete the cheasee-pi images and
containers, forcing a full cold rebuild (roughly 1 GB of downloads).

### Container doesn't start

Compose/Dockerfile live in the CLI cache dir. Rebuild and start:

```bash
cheasee-pi start --build
```

Still failing? The image may be corrupt — force a full no-cache rebuild plus
prune:

```bash
cheasee-pi rebuild
cheasee-pi start
```

Raw compose needs the bind-mount env vars (compose interpolates
`WORKSPACE_HOST_PATH`/`WORKSPACE_BARE_PATH` from the environment — unset
variables are a hard error, even for `build`):

```bash
WORKSPACE_HOST_PATH=$(pwd) \
WORKSPACE_BARE_PATH=$(dirname "$(pwd)")/.bare \
  docker compose -f ~/.cache/cheasee-pi/<version>/docker-compose.yml build --no-cache
```

### Permission errors

The entrypoint auto-detects host UID/GID from the `/workspaces/main` mount.
On macOS/Windows mounts with unusual ownership, pass them explicitly:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) \
  WORKSPACE_HOST_PATH=$(pwd) \
  WORKSPACE_BARE_PATH=$(dirname "$(pwd)")/.bare \
  docker compose -f ~/.cache/cheasee-pi/<version>/docker-compose.yml up
```

### macOS: repo outside Docker Desktop shared roots

Docker Desktop only shares `/Users`, `/Volumes`, `/private`, `/tmp`,
`/var/folders` by default. Repos elsewhere fail at mount time with "Mounts
denied" — move the repo under one of those roots or add it to Docker Desktop's
file-sharing settings.

### SELinux hosts (Fedora/RHEL)

Bind mounts are blocked without relabel labels. Set
`CHEASEEPI_SELINUX_RELABEL=1` when starting to append `:Z` to the mounts.

### Emoji not displaying

Install an emoji font on the host:

```bash
# Debian / Ubuntu
sudo apt install fonts-noto-color-emoji
# Fedora
sudo dnf install google-noto-color-emoji-fonts
# macOS / Windows — bundled, no action needed
```

For git branch icon (``), install a [Nerd Font](https://www.nerdfonts.com/):

```bash
wget -P /tmp https://github.com/ryanoasis/nerd-fonts/releases/download/v3.3.0/JetBrainsMono.zip
sudo unzip /tmp/JetBrainsMono.zip -d /usr/share/fonts/truetype/jetbrains-nerd
sudo fc-cache -fv
```

Then set the font in your terminal to `JetBrainsMono Nerd Font`.

### API keys not picked up

Use `cheasee-pi start` (reads `~/.config/cheasee-pi/auth.json`). If you must use raw docker, the container is named `cheasee-pi-<repo-slug>` (repo slug, not plain `cheasee-pi`):

```bash
CONTAINER=$(docker ps --format '{{.Names}}' | grep '^cheasee-pi-')
docker exec -it \
  -e OPENCODE_API_KEY=$OPENCODE_API_KEY \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  --user agentuser -w /workspaces/main "$CONTAINER" /usr/bin/pi --approve
```

## Uninstall

### Standalone script (recommended)

```bash
curl -fsL https://raw.githubusercontent.com/SchneiderDaniel/cheasee-pi/main/scripts/uninstall.sh | bash
```

Add `--force` to skip the confirmation prompt, `--dry-run` to preview what would be removed. The script removes the binary (from `/usr/local/bin`, `~/.local/bin`, or your PATH), the whole CLI cache dir, and the auth config (`cheasee-pi/auth.json` under your user config dir). Workspace files (`.pi/`, `.git/`, source checkouts) are never touched. It works even if the binary is already gone, and never needs `sudo` (root-owned files like `/usr/local/bin` are elevated per-operation).

### CLI command

`cheasee-pi uninstall` removes the cache dir, auth config, and every
cheasee-pi binary (the running executable plus the canonical install
locations `~/.local/bin` and `/usr/local/bin`):

```bash
cheasee-pi uninstall
```

Run it **without** `sudo` — under sudo, the config/cache paths resolve to root's account and the command would delete root's state, not yours. If the binary lives in a root-owned directory like `/usr/local/bin`, use the standalone script above instead: it elevates per-operation and never needs sudo. When the CLI itself can't remove the binary, it prints a manual `sudo rm` hint with the full path.

Add `--force` to skip confirmation.

---

> Next: [Daily Usage guide](daily-usage.md)
