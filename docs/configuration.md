---
layout: default
title: Configuration
nav_order: 2.6
---

# Configuration

Cheasee-Pi separates workspace settings from credentials. We keep workspace
behavior in `cheasee-settings.json` at the workspace root and provider or
GitHub credentials in the user-level `auth.json` file.

## Configuration files

| File                                   | Scope         | Purpose                                                                                                                                       |
| -------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workspace>/cheasee-settings.json`    | One workspace | Docker limits, provider/model defaults, Git identity, and installed skill repositories. Its presence marks an initialized workspace.          |
| `<UserConfigDir>/cheasee-pi/auth.json` | Current user  | Provider API keys and GitHub OAuth credentials. The CLI writes this file with mode `0600`; `cheasee-pi auth` manages provider keys.           |
| `<workspace>/.pi/settings.json`        | One workspace | Pi-owned settings for extensions, skills, prompts, themes, and other Pi configuration. Pi creates this file; Cheasee-Pi does not scaffold it. |

`UserConfigDir` is resolved by the operating system: Linux uses
`$XDG_CONFIG_HOME` or `~/.config`, macOS uses
`~/Library/Application Support`, and Windows uses `%AppData%`. The CLI cache
uses the OS user cache directory: Linux uses `$XDG_CACHE_HOME` or `~/.cache`,
macOS uses `~/Library/Caches`, and Windows uses `%LocalAppData%`.

The workspace settings file is gitignored and is not overwritten by `init`.
The CLI updates selected values when `cheasee-pi auth add` changes the default
provider or model. The `auth.json` file contains secrets and is not intended
for manual editing. Configuration fields must use the JSON types shown in the
example; malformed JSON or a field with the wrong type prevents the CLI from
loading the settings.

## Workspace settings

The following example shows the main user-editable fields. Values generated
by `init` depend on the selected provider and the host Git configuration.

```json
{
	"defaultProvider": "opencode-go",
	"defaultModel": "kimi-k2.6",
	"docker": {
		"memory": "5G",
		"cpus": "4.0",
		"codeflowPort": "",
		"uiPort": ""
	},
	"gitIdentity": {
		"name": "Example User",
		"email": "user@example.com"
	},
	"oauth": {
		"clientID": "178c6fc778ccc68e1d6a"
	},
	"repository": {
		"url": "https://github.com/owner/repository.git",
		"user": "owner"
	},
	"skillRepos": ["owner/skills"]
}
```

| Key                   | Meaning                                                                          | Default or behavior                                                                                                |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `defaultProvider`     | Provider selected for Pi.                                                        | `opencode-go` on a standard initialization. `cheasee-pi auth add <provider>` selects a provider.                   |
| `defaultModel`        | Model identifier for the selected provider.                                      | `kimi-k2.6` for the default `opencode-go` setup. Adding a provider updates its default model when one is selected. |
| `docker.memory`       | Container memory limit.                                                          | `5G`; expressed as a Docker-compatible memory value.                                                               |
| `docker.cpus`         | Container CPU limit.                                                             | `4.0`; expressed as a Docker Compose CPU quota.                                                                    |
| `docker.codeflowPort` | Host port for the CodeFlow sidecar.                                              | Empty means automatic per-repository selection.                                                                    |
| `docker.uiPort`       | Host port for the web control center.                                            | Omitted or empty means automatic per-repository selection.                                                         |
| `gitIdentity.name`    | Git author name used inside the container.                                       | Initialized from the host Git configuration; otherwise `Cheasee-Pi`.                                               |
| `gitIdentity.email`   | Git author email used inside the container.                                      | Initialized from the host Git configuration; otherwise `cheasee-pi@localhost`.                                     |
| `oauth.clientID`      | GitHub OAuth application client ID used by initialization and re-authentication. | Cheasee-Pi's client ID unless `init --client-id` specifies another value.                                          |
| `repository.url`      | Canonical URL of the repository cloned during initialization.                    | Written by GitHub-enabled `init`; absent in `--no-github` mode.                                                    |
| `repository.user`     | GitHub login resolved during initialization.                                     | Written by GitHub-enabled `init`; absent in `--no-github` mode.                                                    |
| `skillRepos`          | Git-hosted skill repository specifications installed in the container.           | Optional. `init --skill-repo` accepts repeatable `owner/repo`, HTTPS, or `git:host/user/repo[@ref]` values.        |

`docker.codeflowPort` and `docker.uiPort` override the automatically derived
ports. Their corresponding environment variables are `CODEFLOW_PORT` and
`PI_UI_PORT`; the settings file takes precedence over the environment, and
automatic per-repository selection is used when neither is set. The CodeFlow
host bind defaults to loopback; see [Security](security.md) before enabling
remote access with `CODEFLOW_HOST_IP`.

The `oauth` and `repository` sections are initialization metadata. The CLI
uses them during re-authentication and workspace identification; they are not
replacements for the credentials in `auth.json`.

## Credentials and provider keys

`cheasee-pi auth add <provider>` stores a provider key in
`<UserConfigDir>/cheasee-pi/auth.json` and selects that provider in workspace
settings. `cheasee-pi auth list` displays configured providers with masked
keys. `cheasee-pi auth remove <provider>` deletes a key but leaves the
workspace default unchanged; another provider can be selected with
`cheasee-pi auth add <other>`.

GitHub OAuth credentials are stored in the same user-level file. Re-running
`cheasee-pi init --reauth` refreshes GitHub authentication and the provider
API key without recreating the clone or settings scaffold.

Provider-to-environment-variable mappings and other CLI environment
variables are listed in the [CLI reference](cli.md#environment-variables).
The full command behavior is documented in the [CLI reference](cli.md).

### How the containers receive credentials

Containers never receive the host config directories. Compose mounts exactly
one file, read-only:

| What                         | Host source                            | Inside the container        |
| ---------------------------- | -------------------------------------- | --------------------------- |
| Provider keys + GitHub token | `<UserConfigDir>/cheasee-pi/auth.json` | `/run/secrets/cheasee_auth` |

The source is `secrets.cheasee_auth.file`, which the CLI resolves from the same
`auth.json` path it writes (`CHEASEEPI_AUTH_FILE`, defaulting to
`~/.config/cheasee-pi/auth.json`). Outside Swarm a `file:` secret is a
read-only bind mount of that single host file: a process inside the container
can read it and cannot write it, and no other host configuration is exposed.

gh still needs a writable config directory, so `entrypoint.sh` seeds a
container-local tmpfs from the mounted secret (`GH_CONFIG_DIR=
/home/agentuser/.config/gh`). `hosts.yml` lives in memory and disappears with
the container.

No credential value is written into Compose configuration, image layers, or
container environment metadata: `docker compose config` can only ever print
the file path, and provider keys reach pi through `docker exec -e` at session
start.

#### Changing credentials requires a container recreate

`cheasee-pi auth` remains the only writer and `auth.json` the single source of
truth. Because a single-file bind mount is pinned to the inode that existed at
container creation, a credential change is NOT visible to the file-backed
consumers until the container is recreated:

```bash
cheasee-pi auth add <provider>   # or: cheasee-pi init --reauth
cheasee-pi start --build         # recreates the containers
```

`cheasee-pi start` warns (it never recreates on its own) for every container
that already exists — running or stopped — when it was created from a
different credential file than the one now on the host. A container that is
merely started after a CLI upgrade keeps the mounts it was created with (the
pre-#2076 read-write config directories), so that case warns too.

The recreate requirement is specific to the file-backed path. Exec-time
delivery stays live: `GH_TOKEN` and provider keys are resolved on the host on
every start and handed to pi per `docker exec`, so those take effect without a
recreate. The consumers that only see the change after one are the UI's
spawned pi RPC children, the gh tmpfs seed, and the supervisor's `auth.json`
fallback.
