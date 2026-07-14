# Cheasee-Pi: Build Your Own PI. Cheap. Easy. Secure.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/LICENSE)
[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.79.1-6e3bf0)](https://pi.dev)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/CONTRIBUTING.md)

**Token-saving agent harness with security guardrails and a Kanban git-oriented sub-agent framework.** Docker + Pi AI — autonomous Kanban pipeline, sandboxed execution, real-time feedback via git worktrees for parallel development.

![Cheasee-Pi TUI — multi-agent Kanban pipeline](cheasee-pi-tui.png)

## What is Cheasee-Pi?

Cheasee-Pi is a **Pi agent harness** built on the [Pi coding agent](https://pi.dev) — engineered to save tokens, enforce security boundaries, and drive sub-agents through a Kanban git-oriented workflow. It uses a GitHub Project board to orchestrate an autonomous multi-agent pipeline — Researcher → Architect → TestDesigner → Developer → Auditor — with tools that minimise token waste, enforce security boundaries, and streamline development inside isolated git worktrees.

All components run locally. No code leaves your machine (except LLM API calls to your provider).

## Extensions overview

| Extension | Purpose |
|-----------|---------|
| **Structural Analyzer** | AST-aware code search via ast-grep |
| **Ripgrep Search** | Fast literal/regex code search |
| **Supervisor** | Kanban-driven multi-agent pipeline |
| **Web Crawler** | Web crawling with Scrapling + Cloudflare bypass |
| **Web Search** | DuckDuckGo search via ddgs Python lib |
| **Context Info** | Rich TUI status bar (branch, model, tokens, TPS, cache) |
| **Session Logger** | Session logging to JSONL with Markdown reports |
| **Session Advice** | Post-session pattern analysis + feedback loop |
| **Agent Harness** | Runtime tool call validation (blocks dangerous patterns) |
| **Caveman Protocol** | Token-efficient communication |
| **Ponytail** | Lazy senior dev mode — YAGNI, stdlib-first, minimal code |
| **Ask User** | Interactive MC dialogs + CSV logging |
| **Format on Save** | Auto Prettier + ESLint after write/edit |
| **PiIgnore** | Path blocking via `.piignore` patterns |
| **TSC Checkpoint** | `/check` command: `tsc --noEmit` |
| **Check Extensions** | Extension compatibility audit |
| **Worktree Sandbox** | Worktree path enforcement |
| **RTK** | Token-saving bash rewrite — 60-90% less output per command |
| **LSP Auditor** | LSP diagnostics pre-audit for pipeline |

## Quick start

**Recommended:** Download the `cheasee-pi` binary and run `cheasee-pi init` —
see the full [Installation guide](installation.md) for step-by-step setup
(both Go CLI and legacy bash paths).

TL;DR — native Docker workflow (works with either path once set up):

```bash
# Clone the repo (legacy path) or cd into your init-created workspace (Go CLI path)
cd cheasee-pi

# Build image and start container
docker compose -f docker/docker-compose.yml up -d --build

# Run pi inside the container
docker exec -it --user agentuser -w /workspaces/main cheasee-pi pi

# Stop and remove container when done
docker compose -f docker/docker-compose.yml down
```

First run builds the Docker image (~2 min). Set your API key inside the container
when pi prompts you, or pass it via `-e`:

```bash
docker exec -it -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  --user agentuser -w /workspaces/main cheasee-pi pi
```

> **Rebuild after dependency changes:** `docker compose -f docker/docker-compose.yml build && docker compose -f docker/docker-compose.yml up -d`

For the full daily usage guide — parallel sessions, troubleshooting, and convenience
scripts — see the [Daily Usage guide](daily-usage.md).

The original `./cheasee-pi.sh` wrapper is still available as a legacy convenience
alternative. Run it for an all-in-one experience (build, start, env injection).

## Documentation

Full documentation is at **[schneiderdaniel.github.io/cheasee-pi](https://schneiderdaniel.github.io/cheasee-pi/)**.

| Section | What's there |
|---------|-------------|
| [Installation](https://schneiderdaniel.github.io/cheasee-pi/installation) | Prerequisites, step-by-step setup, verification |
| [Daily Usage](https://schneiderdaniel.github.io/cheasee-pi/daily-usage) | Docker workflow, parallel sessions, troubleshooting |
| [Architecture](https://schneiderdaniel.github.io/cheasee-pi/architecture) | System design, extensions vs MCP, git worktrees, pipeline |
| [Extensions](https://schneiderdaniel.github.io/cheasee-pi/extensions) | All 19 extensions, agent definitions, published packages |
| [Skills](https://schneiderdaniel.github.io/cheasee-pi/skills) | 5 reusable skill definitions |
| [Methodology](https://schneiderdaniel.github.io/cheasee-pi/methodology) | Kanban pipeline, security, token efficiency, daily use |
| [Prompts](https://schneiderdaniel.github.io/cheasee-pi/prompts) | 11 prompt templates |
| [SBOM](https://schneiderdaniel.github.io/cheasee-pi/sbom) | Software Bill of Materials |
| [Acknowledgements](https://schneiderdaniel.github.io/cheasee-pi/acknowledgements) | Credits and licenses |

## Daily workflow

### Typical session

1. Start with `pi`
2. Select or create a GitHub issue
3. Run `/supervisor <issue-number>` to start the Kanban pipeline
4. Monitor progress via TUI status bar
5. Review results when pipeline completes

### Update after dependency changes

When pi, ponytail, or any container dependency updates, rebuild the image:

```bash
docker compose -f docker/docker-compose.yml build && docker compose -f docker/docker-compose.yml up -d
```

Or use the legacy convenience wrapper:

```bash
./cheasee-pi.sh --rebuild
```

Both rebuild the Docker image with updated packages and restart the container.

## Contributing

1. Fork the repository
2. Create a feature worktree: `git worktree add -b my-feature ../my-feature main`
3. `cd ../my-feature` and make your changes
4. Run tests: `npm test`
5. Push and submit a PR
6. Clean up: `git worktree remove --force ../my-feature`

## Philosophy

Everyone should build their own Pi. This repo is **my personal** Pi agent harness. Fork it as a starting point, but the real power comes from shaping it into **your own** — your preferred tools, your workflows, your guardrails.

Customize ruthlessly. Make it yours.

## License

MIT © 2025. See [LICENSE](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/LICENSE).
