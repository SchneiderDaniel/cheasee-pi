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
| **Agent Harness** | Runtime tool call validation (blocks dangerous patterns) |
| **Caveman Protocol** | Token-efficient communication |
| **Ponytail** | Lazy senior dev mode — YAGNI, stdlib-first, minimal code |
| **Ask User** | Interactive MC dialogs + CSV logging |
| **Format on Save** | Auto Prettier + ESLint after write/edit |
| **PiIgnore** | Path blocking via `.piignore` patterns |
| **TSC Checkpoint** | `/check` command: `tsc --noEmit` |
| **Worktree Sandbox** | Worktree path enforcement |
| **RTK** | Token-saving bash rewrite — 60-90% less output per command |
| **LSP Auditor** | LSP diagnostics pre-audit for pipeline |

## Quick start

### Install in one line

```bash
curl -fsL https://raw.githubusercontent.com/SchneiderDaniel/cheasee-pi/main/scripts/install.sh | bash
```

Or manually from the [latest release](https://github.com/SchneiderDaniel/cheasee-pi/releases).

### Using the CLI (auto)

```bash
cheasee-pi init           # empty-folder setup: repo URL, auth, bare clone + worktree,
                          # scaffold gitignored cheasee-settings.json
cheasee-pi start          # empty folder → auto-init; workspace → start pi (default)
cheasee-pi down           # stop and remove container
cheasee-pi clean          # kill orphaned pi sessions + prune Docker garbage
cheasee-pi build          # rebuild container image (Dockerfile/entrypoint changes)
cheasee-pi auth add       # add API key for a provider
cheasee-pi auth list      # list configured providers/keys
cheasee-pi auth remove    # remove a provider key
```

See [Installation guide](installation.md) for prerequisites and step-by-step setup.

## Documentation

Full documentation is at **[schneiderdaniel.github.io/cheasee-pi](https://schneiderdaniel.github.io/cheasee-pi/)**.

| Section | What's there |
|---------|-------------|
| [Installation](https://schneiderdaniel.github.io/cheasee-pi/installation) | Prerequisites, step-by-step setup, verification |
| [Daily Usage](https://schneiderdaniel.github.io/cheasee-pi/daily-usage) | Docker workflow, parallel sessions, troubleshooting |
| [Architecture](https://schneiderdaniel.github.io/cheasee-pi/architecture) | System design, extensions vs MCP, git worktrees, pipeline |
| [Extensions](https://schneiderdaniel.github.io/cheasee-pi/extensions) | All 17 extensions, agent definitions, published packages |
| [Skills](https://schneiderdaniel.github.io/cheasee-pi/skills) | 21 skill definitions (11 auto-loaded, 10 manual) |
| [Methodology](https://schneiderdaniel.github.io/cheasee-pi/methodology) | Kanban pipeline, security, token efficiency, daily use |
| [Prompts](https://schneiderdaniel.github.io/cheasee-pi/prompts) | Internal-only prompts (all Cheasee-Pi prompts converted to skills) |
| [SBOM](https://schneiderdaniel.github.io/cheasee-pi/sbom) | Software Bill of Materials |
| [Acknowledgements](https://schneiderdaniel.github.io/cheasee-pi/acknowledgements) | Credits and licenses |

## Daily workflow

### Typical session

1. Start with `pi`
2. Select or create a GitHub issue
3. Run `/supervisor <issue-number>` to start the Kanban pipeline
4. Monitor progress via TUI status bar
5. Review results when pipeline completes

### Update pi

Pi is installed as `@latest` at image build time; `cheasee-pi start`
rebuilds the image whenever the container isn't running, so pi updates
automatically on every start. No action needed.

For Dockerfile / entrypoint changes (new tools, config), rebuild:

```bash
cheasee-pi start --build
```

### CodeFlow (code-structure visualization)

The stack ships a local CodeFlow service (browser-based dependency/architecture
visualizer, tree-sitter AST, 18 languages). It starts automatically with
`cheasee-pi start` and serves on port 8470. See
[Daily usage > CodeFlow](docs/daily-usage.md#codeflow-code-structure-visualization)
for configuration (`cmd/cheasee-pi/embedded/docker/codeflow/config.json`).

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
