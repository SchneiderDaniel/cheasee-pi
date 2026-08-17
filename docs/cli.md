---
layout: default
title: CLI Reference
nav_order: 2.5
---

# CLI Reference

`cheasee-pi` is the Docker-based launcher for the pi coding agent. It sets up
a workspace, launches pi inside a container with provider keys injected, and
manages the container lifecycle. This page is the command reference — every
command's **does**, **checks**, and **inputs** at a glance. For step-by-step
setup and daily walkthroughs, see [Installation](installation.md) and
[Daily Usage](daily-usage.md).

## At a glance

| Command | Does | Key inputs |
|---|---|---|
| `cheasee-pi` (no args) | Launch pi in the container — alias of `start` | workspace, API keys |
| `cheasee-pi start` (alias `up`) | Launch pi inside the container with provider keys injected | workspace, `--build` to rebuild first |
| `cheasee-pi init` | Set up workspace: bare clone + main worktree + `cheasee-settings.json` | empty folder, repo URL |
| `cheasee-pi auth add \| remove \| list \| envvars` | Manage provider API keys | provider, key |
| `cheasee-pi build` (full: `rebuild`) | Rebuild the Docker image | workspace settings |
| `cheasee-pi down` (alias `stop`) | Stop and remove the container for this workspace | — |
| `cheasee-pi clean` | Kill orphaned pi sessions, remove all containers, prune Docker garbage | confirmation |
| `cheasee-pi uninstall` | Remove config + extracted files | confirmation |

`cheasee-pi --version` prints the CLI version. `cheasee-pi --help` lists every
subcommand.

## Lifecycle

| Step | Command | What happens |
|---|---|---|
| 1 | `cheasee-pi init` | empty-folder workspace setup (clone, scaffold, auth) |
| 2 | `cheasee-pi auth add <provider>` | store API key, set default provider |
| 3 | `cheasee-pi start` | build image on first run, launch pi |
| 4 | (work) | interactive pi session inside the container |
| 5 | `cheasee-pi down` | stop and remove this workspace's container |
| 6 | `cheasee-pi clean` | sweep every container + orphan sessions, prune |

An empty folder can skip step 1: `cheasee-pi start` auto-runs init and
stops (init never launches pi); run `cheasee-pi start` again to launch.

## `cheasee-pi` (no args) / `start`

Launch an interactive pi session inside the container. The root command run
without a subcommand executes the same handler as `start`.

| | |
|---|---|
| **Does** | Mounts the workspace at `/workspaces/main` and its sibling bare clone at `/workspaces/.bare`, starts the container (`docker compose up` if not running), injects provider keys from `~/.config/cheasee-pi/auth.json` as environment variables, launches pi, and prints the CodeFlow URL (`http://localhost:<port>/?repo=local/workspace&run=1`) once the container is healthy. |
| **Checks** | Workspace gate: empty folder → runs `init` and stops (re-run `start` to launch pi); `cheasee-settings.json` present → run; non-empty folder without it → refused with an empty-folder hint. Docker gate (binary present + `docker info` responds + Engine ≥ 24.0.0, 5 s timeout) unless `--no-docker-check`. |
| **Inputs** | Flags: `--workdir`, `--name`, `--build`, `--no-docker-check`, `--api-key` (session-only, not saved), `--dry-run` (print injected env vars, then exit). Reads `auth.json` + `cheasee-settings.json`; writes the version-keyed compose/Dockerfile cache. |

## `cheasee-pi init`

Set up a cheasee-pi workspace from scratch: bare clone to `<workdir>/.bare`,
main worktree in the branch-named subfolder (`<workdir>/main` by default),
and the dedicated `cheasee-settings.json` scaffolded inside that worktree
leaf (gitignored, machine-local). GitHub OAuth (device flow) is the
primary authentication; `--no-github` falls back to the legacy API-key-only
path (no clone, no repo URL).

| | |
|---|---|
| **Does** | Bare-clones the project repo, adds the main worktree in a branch-named subfolder of the workspace (`<workdir>/main` unless a different branch is stated), scaffolds `cheasee-settings.json` in the worktree leaf (never overwrites an existing one), authenticates GitHub, records custom skill repos, saves auth config, and sets up the provider API key. Prints `cheasee-pi start` as the next step — init never launches pi (the second `start` invocation does). |
| **Checks** | Docker gate unless `--no-docker-check`. Empty-folder probe: non-empty folders are refused (`.DS_Store` tolerated). `cheasee-settings.json` presence marks the workspace initialized — init refuses it unless `--reauth` (which re-runs only the GitHub + API-key authentications). Single invocation capped at a 5-minute timeout (device-flow OAuth polling dominates). `--no-input` requires `--repo-url`. |
| **Inputs** | Repo URL (`--repo-url` or interactive prompt), branch naming the worktree folder (interactive prompt, default `main`), GitHub OAuth device flow, API key (`--api-key` or prompt), provider name. Files written: `cheasee-settings.json` in the worktree leaf, `~/.config/cheasee-pi/auth.json`, `.pi/` agent settings, sibling `.bare` clone + worktree leaf. |

### init flags

| Flag | Meaning |
|---|---|
| `--workdir <dir>` | Working directory (default: current directory) |
| `--no-github` | Legacy API-key-only path — skip the clone and GitHub OAuth entirely |
| `--client-id <id>` | GitHub OAuth app client ID (default: cheasee-pi's app) |
| `--provider <name>` | Provider name for the API key (default: opencode-go) |
| `--no-input` | Skip all interactive prompts (`--repo-url` then required) |
| `--api-key <key>` | API key, skips the interactive prompt |
| `--no-docker-check` | Skip the Docker Engine check |
| `--repo-url <url>` | Project repository URL for the clone (`owner/repo` or GitHub URL) |
| `--reauth` | Redo GitHub + pi API-key authentications on an initialized workspace |
| `--skill-repo <spec>` | Custom skill repository installed into the container (repeatable) |

## `cheasee-pi auth`

Manage provider API keys. Keys live in `~/.config/cheasee-pi/auth.json`
(0600, atomic writes) and the last-added provider becomes the default in the
workspace settings.

| Subcommand | Does | Inputs / checks |
|---|---|---|
| `auth add [provider]` | Add or update a provider API key; sets it as the default provider (and model) in the workspace settings | provider name or interactive picker; `--workdir`, `--no-input` (skip model selection). Saves to `auth.json` + `cheasee-settings.json` + `.pi/agent/settings.json` |
| `auth remove <provider>` | Delete the key from `auth.json` | exact provider name; `--workdir`. Leaves `defaultProvider`/`defaultModel` in `cheasee-settings.json` untouched — switch the default with `cheasee-pi auth add <other>` |
| `auth list` | List configured providers (masked keys) + the workspace default | `--workdir` |
| `auth envvars` | Print the canonical provider→env var mapping (shell format by default) | `--format shell\|json`; emits no key values |

## `cheasee-pi build` / `rebuild`

Rebuild the Docker image without starting the container. `build` reuses the
Docker layer cache; `rebuild` is a full no-cache rebuild plus prune
(`build --no-cache` is a compatibility alias for a full rebuild).

| | |
|---|---|
| **Does** | Rebuilds the image from the compose/Dockerfile in the version-keyed cache dir; passes `CHEASEEPI_MEMORY` from `cheasee-settings.json` as a build arg. |
| **Checks** | Runs from a git repo (settings + git identity come from it). Docker gate unless `--no-docker-check`. Compose validates every volume spec, so the workspace path must resolve. |
| **Inputs** | Flags: `--workdir`, `--no-docker-check`, `--no-cache`. Reads `cheasee-settings.json` (`docker.memory`). |
| **Note** | A cached build does not apply the new image to a running container — apply with `cheasee-pi start --build` or `cheasee-pi down` + `cheasee-pi start`. |

## `cheasee-pi down`

Stop and remove the Docker container for the current workspace via
`docker compose down` (alias `stop`).

| | |
|---|---|
| **Does** | Removes the compose project derived from this workspace's repo — sibling workspaces' containers keep running. |
| **Checks** | No-ops when no container matches the workspace's project. Legacy pre-derivation containers (project `cheasee-pi`) are deliberately not targeted — `cheasee-pi clean` removes those. |
| **Inputs** | None (no flags). |

## `cheasee-pi clean`

Kill orphaned/stale pi sessions and remove all cheasee-pi containers.

| | |
|---|---|
| **Does** | Enumerates ALL managed containers on the host (every repo, running or stopped), force-removes each, kills orphaned pi processes inside them, and prunes dangling images + build cache. |
| **Checks** | Lists the matches and asks for confirmation before killing anything (`--yes` skips, `--dry-run` previews). Default scope is every cheasee-pi container on the host — `--name` scopes to a single container. |
| **Inputs** | Flags: `--name <container>` (scope), `--older-than <minutes>` (orphan age reap; `0` disables), `--dry-run`, `--yes`. |

## `cheasee-pi uninstall`

Remove cheasee-pi configuration and CLI-managed assets.

| | |
|---|---|
| **Does** | Removes the version-keyed cache dir (compose/Dockerfile), `~/.config/cheasee-pi/auth.json`, and the running binary. Workspace files (`.pi/`, `.git/`, source checkouts) are never touched. |
| **Checks** | Shows a summary and asks for confirmation (`--force` skips). Skips binary removal when running from a Go build cache; warns when the binary's directory is not writable. |
| **Inputs** | Flags: `--force`. |

## Environment variables

Provider keys are read from `~/.config/cheasee-pi/auth.json`, not the
environment — the mapping below is what the CLI injects into the container.
`cheasee-pi auth envvars` is the canonical live source.

| Provider | Env var |
|---|---|
| opencode-go (alias: opencode) | `OPENCODE_API_KEY` |
| openai | `OPENAI_API_KEY` |
| anthropic (alias: claude) | `ANTHROPIC_API_KEY` |
| deepseek | `DEEPSEEK_API_KEY` |
| gemini (alias: google) | `GEMINI_API_KEY` |
| groq | `GROQ_API_KEY` |
| mistral | `MISTRAL_API_KEY` |
| openrouter | `OPENROUTER_API_KEY` |
| xai | `XAI_API_KEY` |
| fireworks | `FIREWORKS_API_KEY` |
| together | `TOGETHER_API_KEY` |
| cerebras | `CEREBRAS_API_KEY` |

Passthrough from the host environment (when set):

- `GH_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

Other variables the CLI reads:

| Variable | Meaning |
|---|---|
| `CODEFLOW_PORT` | Host port for the CodeFlow sidecar. Resolution order: `docker.codeflowPort` in `cheasee-settings.json` → env `CODEFLOW_PORT` → derived `8470 + fnv32(repo-slug) % 1024`, probed next-free |
| `CHEASEEPI_MEMORY` | Build arg passed by `build`/`rebuild` from `docker.memory` in `cheasee-settings.json` |
| `XDG_CACHE_HOME` (Unix) / `LocalAppData` (Windows) | Base for the CLI cache dir via `os.UserCacheDir` |

## Files and artifacts

| Path | Role |
|---|---|
| `~/.config/cheasee-pi/auth.json` | Provider API keys + GitHub token/user (0600, atomic writes) |
| `<workspace>/cheasee-settings.json` | Initialized marker; `defaultProvider`/`defaultModel`, docker settings, skill repos (tab-indented, never overwritten by init) |
| `<UserCacheDir>/cheasee-pi/<version>` | CLI-managed cache: `docker-compose.yml`, `Dockerfile` (extracted on demand) |
| `<workspace>/.pi/` | pi agent config (settings, agent settings) |
| `<workdir>/.bare` | Sibling bare clone, mounted at `/workspaces/.bare` in the container |
| container `cheasee-pi-<repo-slug>` | Per-repo Docker container (workspace mounts at `/workspaces/main`) |

## Where to go deeper

- [Installation](installation.md) — prerequisites, install, first setup, uninstall
- [Daily Usage](daily-usage.md) — start/stop flows, CodeFlow, parallel workspaces, troubleshooting
