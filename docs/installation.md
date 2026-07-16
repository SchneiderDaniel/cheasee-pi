---
layout: default
title: Installation
nav_order: 2
---

# Installation

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Prerequisites

**Dependencies:** [Docker Engine](https://docs.docker.com/engine/install/) ≥24.0 with Compose V2 + [git](https://git-scm.com/).

Git identity is required so the supervisor extension can commit changes inside the
container. The host's `git config user.name` and `git config user.email` are passed
into the container automatically by the setup scripts. If unset on the host, the
container defaults to `Cheasee-Pi <cheasee-pi@localhost>`.

**Emoji font (optional, recommended):** The `context-info` extension and various
TUI components display emoji icons (🧠, 🔧, 🔒, 📦, ⏱). The container image
includes `fonts-noto-color-emoji`, but the host terminal emulator must also
possess an emoji-capable font for glyph rendering. Most desktop environments
ship one by default (Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji).
If emoji appear as empty boxes (`□`, `▯`) when running the Pi TUI, install
an emoji font on the host:

```bash
# Debian / Ubuntu host
sudo apt install fonts-noto-color-emoji

# Fedora / RHEL
sudo dnf install google-noto-color-emoji-fonts

# macOS / Windows — fonts are bundled; no action required
```

See the [Troubleshooting](#emoji-icons-not-displaying) section if icons still
don't render after installation.

---

> **Recommended:** Static binary, one `init` command replaces manual
> fork/clone/submodule/extract. ~15–30 MB download vs ~500 MB clone. No Go toolchain
> required. Supports **Linux** and **macOS** (Intel + Apple Silicon).

---

## Go CLI Path (Recommended) {: #go-cli-path }

**Best for new users.** Download a statically linked binary from GitHub Releases and run
`cheasee-pi init` to set up your fork, clone, submodule, and Docker configuration in a
single interactive command.

**Supported platforms:** Linux (amd64, arm64), macOS (amd64, arm64), and Windows (amd64, arm64).

> **Size:** The Go binary is ~15–30 MB. Compare to a full repo clone at ~500 MB
> (includes node_modules, test fixtures, images) — a 15–30× bandwidth saving.

### Step 1: Download the binary

Visit the [GitHub Releases page](https://github.com/SchneiderDaniel/cheasee-pi/releases)
and download the archive matching your OS and architecture.

**Linux / macOS** — use the terminal:

```bash
# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Map uname arch to GoReleaser arch names
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  arm64)   ARCH="arm64" ;;
esac

# Download the latest release archive
VERSION="0.31.0"
curl -fLO "https://github.com/SchneiderDaniel/cheasee-pi/releases/download/v${VERSION}/cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz"
```

**Windows (PowerShell)** — run in PowerShell:

```powershell
# Detect architecture
$ARCH = if ((Get-CimInstance Win32_ComputerSystem).SystemType -match "ARM") { "arm64" } else { "amd64" }
$VERSION = "0.31.0"
Invoke-WebRequest -Uri "https://github.com/SchneiderDaniel/cheasee-pi/releases/download/v$VERSION/cheasee-pi_$VERSION`_windows_$ARCH.zip" -OutFile "cheasee-pi.zip"
```

Adjust `$VERSION` to the latest release tag.

### Step 2: Verify the checksum (optional but recommended)

Download the checksums file and verify the archive:

**Linux / macOS:**

```bash
curl -fLO "https://github.com/SchneiderDaniel/cheasee-pi/releases/download/v${VERSION}/checksums.txt"
sha256sum -c checksums.txt 2>&1 | grep OK
```

Expected output includes `cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz: OK`.

**Windows (PowerShell):**

```powershell
$VERSION = "0.31.0"
Invoke-WebRequest -Uri "https://github.com/SchneiderDaniel/cheasee-pi/releases/download/v$VERSION/checksums.txt" -OutFile "checksums.txt"
# Verify the .zip checksum (PowerShell 5.1+)
$expectedHash = (Get-Content checksums.txt | Select-String "cheasee-pi_$VERSION`_windows_amd64.zip" | ForEach-Object { $_ -split ' ' | Select-Object -First 1 })
$actualHash = (Get-FileHash cheasee-pi.zip -Algorithm SHA256).Hash.ToLower()
if ($expectedHash -eq $actualHash) { Write-Host "OK" } else { Write-Host "CHECKSUM MISMATCH" }
```

### Step 3: Extract and install

**Linux / macOS:**

```bash
tar -xzf "cheasee-pi_${VERSION}_${OS}_${ARCH}.tar.gz"
chmod +x cheasee-pi
sudo mv cheasee-pi /usr/local/bin/
```

**Windows (PowerShell):**

```powershell
# Extract the downloaded archive
tar -xf cheasee-pi.zip
# Place in a directory on your PATH (e.g., C:\cheasee-pi)
Move-Item cheasee-pi.exe C:\cheasee-pi\
# Add to PATH for the current session
$env:Path += ";C:\cheasee-pi"
# To make permanent, add to your PowerShell profile:
# [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\cheasee-pi", "User")
```

Verify the binary works:

```powershell
cheasee-pi version
```

> **macOS only:** Gatekeeper may block the unsigned binary. If you see
> "“cheasee-pi” cannot be opened because the developer cannot be verified",
> remove the quarantine attribute:
>
> ```bash
> xattr -d com.apple.quarantine /usr/local/bin/cheasee-pi
> ```
>
> Or Ctrl-click → Open in Finder and confirm.

Verify the binary works:

```bash
cheasee-pi version
```

### Step 4: Verify Docker is installed

```bash
docker compose version
docker info
```

If Docker is not installed, see the [platform-specific install table](#step-1-install-docker)
before proceeding.

### Step 5: Run `cheasee-pi init`

This single interactive command replaces Steps 3–5 of the legacy path (fork, clone,
submodule config, compose extraction, and env file generation).

```bash
cheasee-pi init
```

`cheasee-pi init` will:

1. Verify Docker Engine is running
2. Open GitHub OAuth device flow to authenticate (browser window)
3. **Prompt for the repository to fork** (default: `SchneiderDaniel/cheasee-pi`; accepts `owner/repo`, full URL, or git URL)
4. Fork the source repo to your GitHub account
5. Clone your fork with a bare worktree setup
6. Configure the submodule
7. **Confirm the fork location and workdir** before proceeding
8. Extract embedded `docker-compose.yml`, `Dockerfile`, and `entrypoint.sh`
9. Generate `docker/.env` with your settings
10. Save authentication config to your platform's XDG user config directory (e.g., `~/.config/cheasee-pi/auth.json` on Linux; the exact path is printed at runtime as "✓ Auth config saved to...")

After completion, you'll see:

```
✅ Init complete! Next step:
   bash docker/run-pi.sh
```

> **No GitHub?** Use `cheasee-pi init --no-github` to skip the GitHub OAuth and fork
> steps. You'll need to provide your API key manually.
>
> **Flags for advanced fork control:**
> - `--fork-url <URL>` — specify an existing fork URL to skip the fork+clone steps entirely
> - `--skip-fork` — skip the fork and clone steps, use existing repo
> - `--no-input` — skip all interactive prompts (for CI / automated setups)

### Step 6: Run pi with the convenience script

```bash
bash docker/run-pi.sh
```

This single command starts the container if needed, injects API keys from your
saved `auth.json` or environment variables, and opens the pi TUI. First run
builds the Docker image (~2 min).

When you're done, stop the container with:

```bash
bash docker/stop-pi.sh
```

#### Advanced — native Docker workflow

If you need to manage the container directly (alternative to the convenience script):

```bash
# Build image and start container
docker compose -f docker/docker-compose.yml up -d --build

# Run pi inside the container
docker exec -it --user agentuser -w /workspaces/main cheasee-pi pi

# Stop and remove container when done
docker compose -f docker/docker-compose.yml down
```

To pass API keys from your host environment:

```bash
docker exec -it \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  --user agentuser -w /workspaces/main cheasee-pi pi
```

### Step 7: Configure repository settings

After forking, update `.pi/settings.json` so the pipeline targets your fork:

| Field | Type | Must change? | Description |
|-------|------|-------------|-------------|
| `supervisor.repo` | string | **Yes** | Your fork (`YOUR_USER/cheasee-pi`) |
| `supervisor.projectNumber` | number | If using kanban | GitHub project number |
| `supervisor.statusField` | string | If using kanban | Single-select field name |
| `defaultProvider` | string | Optional | AI provider for agents |
| `defaultModel` | string | Optional | Default model |
| `theme` | string | Optional | TUI theme from `.pi/themes/` |
| `docker.memory` | string | Optional | Container memory limit |
| `docker.cpus` | string | Optional | Container CPU limit |

```bash
nano .pi/settings.json
```

## IDE (optional)

Any IDE works with the workspace. We recommend [Zed](https://zed.dev/) for optimal experience:

```bash
curl -f https://zed.dev/install.sh | sh
sudo ln -s ~/.local/bin/zed /usr/local/bin/zed
```

Open the workspace: `zed .` from the `cheasee-pi` root.

## What happens under the hood

The `docker compose -f docker/docker-compose.yml up -d --build` command runs `docker compose up` with:

- Image built from `docker/Dockerfile` (Debian 12-slim, Node.js 22, Python 3, ripgrep, ast-grep, pi, gosu)
- Workspace root (`../` relative to `main/`) bind-mounted to `/workspaces` inside the container — your worktree at `/workspaces/main`
- Host UID/GID mapped to container user `agentuser` (no permission issues)
- Interactive TTY for the Pi TUI

## Verification

All checks run inside the container.

### Tool verification

```bash
# Structural search
pi "Use structural_search to find all console.log calls in TypeScript files"

# Text search
pi "Use ripgrep_search to find 'TODO' in the project"

# Web search
pi "Use web_search to find 'latest rust web framework 2026' with maxResults=5"
```

### Pi autonomy check

```bash
pi "Respond with exactly one word: 'Operational'."
```

### Execution routing test

```bash
pi -p "Create a file named '.pi/test-file.txt' with content 'container works', then tell me the absolute path."
```

**Expected:** `/workspaces/main/.pi/test-file.txt`

## Troubleshooting

### Container doesn't start

Rebuild the image without cache:

```bash
docker compose -f docker/docker-compose.yml build --no-cache
docker compose -f docker/docker-compose.yml up -d --build
```

### Permission errors on bind-mounted files

The Docker Compose command auto-maps UID/GID. If you need to run manually:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f docker/docker-compose.yml up
```

### Emoji / icons not displaying

Emoji icons (🧠, 🔧, 🔒, 📦, ⏱) in the footer bar or TUI appear as empty boxes
(`□`, `▯`) when the host terminal emulator lacks an emoji-capable font.

The container includes `fonts-noto-color-emoji` since Layer 3 of the Docker
image. The host terminal performs the final rendering, however — the container
merely transmits the encoded bytes.

**To verify inside the container:**

```bash
printf "\U1F9E0 \U1F527 \U1F512 \U1F4E6 \U23F1\n"
```

If the output displays correctly, the host terminal supports emoji and the issue
resides elsewhere (extension configuration, terminal encoding, Pi session
stale). If the output shows boxes, install an emoji font on the host:

```bash
# Debian / Ubuntu host
sudo apt install fonts-noto-color-emoji

# Fedora / RHEL
sudo dnf install google-noto-color-emoji-fonts

# macOS / Windows — fonts are bundled; no action required
```

After installing, rebuild font cache and restart the Pi session:

```bash
sudo fc-cache -fv
# Exit pi (/exit), then restart:
docker compose -f docker/docker-compose.yml up -d
```

**Nerd Font for git branch icon:** The footer also uses `` (U+E0A0) from
[Nerd Font](https://www.nerdfonts.com/) for the git branch indicator. Noto
Color Emoji does not cover this. Install a Nerd Font on the host:

```bash
wget -P /tmp https://github.com/ryanoasis/nerd-fonts/releases/download/v3.3.0/JetBrainsMono.zip
sudo unzip /tmp/JetBrainsMono.zip -d /usr/share/fonts/truetype/jetbrains-nerd
sudo fc-cache -fv
```

Then configure Zed (if using it) to use the Nerd Font:

```json
{
  "terminal": {
    "font_family": "JetBrainsMono Nerd Font"
  }
}
```

The project-level `.zed/settings.json` already contains this setting — adjust
the font name to match the Nerd Font you installed.

**Rebuild the container after any Dockerfile change:**

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

---

> **Next steps?** After installation, head over to the [Daily Usage guide](daily-usage.md)
> for running pi, managing parallel sessions, stop/start workflows, and troubleshooting.
