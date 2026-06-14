# Cheasee-Pi: Build Your Own PI. Cheap. Easy. Secure.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.79.1-6e3bf0)](https://pi.dev)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Token-saving agent harness with security guardrails and a Kanban git-oriented sub-agent framework.** Docker + Pi AI — autonomous Kanban pipeline, sandboxed execution, real-time feedback via git worktrees for parallel development.

![Cheasee-Pi TUI — multi-agent Kanban pipeline](cheasee-pi-tui.png)

---

## Table of Contents

- [Your Journey](#your-journey)
  - [1. Discovery — What is Cheasee-Pi?](#1-discovery--what-is-cheasee-pi)
  - [2. Philosophy — Why build your own?](#2-philosophy--why-build-your-own)
  - [3. Preparation — What you need on your machine](#3-preparation--what-you-need-on-your-machine)
  - [4. Installation — How to set it up](#4-installation--how-to-set-it-up)
  - [5. Orientation — What did I just install?](#5-orientation--what-did-i-just-install)
  - [6. Verification — Does everything work?](#6-verification--does-everything-work)
  - [7. Daily Use — How to work with Cheasee-Pi](#7-daily-use--how-to-work-with-cheasee-pi)
  - [8. Power User — The Multi-Agent Pipeline](#8-power-user--the-multi-agent-pipeline)
  - [9. Troubleshooting — Something broke](#9-troubleshooting--something-broke)
  - [10. Contributing — I want to help](#10-contributing--i-want-to-help)
- [Appendix](#appendix)
  - [SBOM — Software Bill of Materials](#sbom--software-bill-of-materials)
  - [Security](#security)
  - [License](#license)
  - [Acknowledgments](#acknowledgments)

---

## Your Journey

This README follows your path from first encounter to daily use. Each section is one step in that journey.

---

### 1. Discovery — What is Cheasee-Pi?

Cheasee-Pi is a **Pi agent harness** built on the [Pi coding agent](https://pi.dev) — engineered to save tokens, enforce security boundaries, and drive sub-agents through a Kanban git-oriented workflow. It uses a GitHub Project board to orchestrate an autonomous multi-agent pipeline — Researcher → Architect → TestDesigner → Developer → Auditor — with tools that minimise token waste, enforce security boundaries, and streamline development inside isolated git worktrees. Clone this repo and you get a complete toolchain:

- **Structural search** — `structural_search` via ast-grep: AST-aware pattern matching for finding function/class definitions, method calls, try/catch blocks
- **Text search** — `ripgrep_search` via ripgrep: fast literal/regex code search
- **Web crawling** — `web_crawl`: Scrapling (progressive fetch with automatic Cloudflare bypass)
- **Rich TUI** — Custom status bar (branch, model, token usage, TPS, cache stats, cache hit rate, session name, trust status), welcome banner
- **Session logging** — Every conversation saved as JSONL, queryable with jq
- **Multi-agent pipeline** — Autonomous Kanban: Researcher → Architect → TestDesigner → Developer → Auditor
- **LSP pre-audit** — Real LSP diagnostics before merge, auto-retry on errors
- **TypeScript checkpoint** — `/check` command: `tsc --noEmit` on demand
- **PiIgnore** — Block paths from agent read/write/edit/bash
- **Format on save** — Auto Prettier + ESLint after every write/edit
- **Writing voice prompt** — Derive a consistent AI writing voice from sample text (paste, URL, or file), generates `voice-{lang}.md` style guide
- **Extensions-based** — 12+ secure pi extensions, no MCP servers, no network-exposed endpoints
- **Custom theme** — Dark cyberpunk TUI (cheasee-pi)
- **Loading screen** — Extension loading splash with spinner animation, progress events, and extension status visible during startup — integrated into the pi extension loading pipeline

All components run locally. No code leaves your machine (except LLM API calls to your provider).

---

### 2. Philosophy — Why build your own?

Everyone should build their own Pi. This repo is **my personal** Pi agent harness. Fork it as a starting point, but the real power comes from shaping it into **your own** — your preferred tools, your workflows, your guardrails.

Why? Every developer and every team is different. The most effective way of working with an AI coding harness is the one that fits **your** workflow, not a one-size-fits-all maximalist suite. A harness packed with every imaginable feature often gets in the way. The best harness is the one you build for yourself.

Customize ruthlessly. Make it yours.

---

### 3. Preparation — What you need on your machine

**One dependency:** Docker Engine ≥24.0 with Compose V2.

| Platform    | Install Link                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Linux**   | [Docker Engine](https://docs.docker.com/engine/install/) + [Compose V2](https://docs.docker.com/compose/install/linux/) |
| **macOS**   | [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac/) (includes Engine + Compose V2)                     |
| **Windows** | WSL2 + [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows/)                                         |

**Platform:** Docker-only. Linux native, macOS via Docker Desktop, Windows via WSL2 + Docker Desktop.

**API keys:** Copy `docker/agent_env.example` to `.agent_env` and fill in your keys. The container loads this file automatically.

---

### 4. Installation — How to set it up

#### Quick-start

```bash
git clone git@github.com:SchneiderDaniel/cheasee-pi.git
cd cheasee-pi
./cheasee-pi.sh
```

That's it. The wrapper script:

1. Builds the OCI image from `docker/Dockerfile` (first run, ~2 min; cached thereafter)
2. Starts the container with your repo bind-mounted, API keys loaded, and UID/GID mapped
3. Drops you into the Pi TUI inside the container

#### Step-by-step

**1. Clone the repo**

```bash
git clone git@github.com:SchneiderDaniel/cheasee-pi.git && cd cheasee-pi
```

**2. Configure API keys**

```bash
cp docker/agent_env.example .agent_env
# Edit .agent_env with your keys (e.g., APIFY_TOKEN)
```

**3. Launch**

```bash
./cheasee-pi.sh
```

**4. Set provider (first session only)**

```bash
pi --provider opencode-go --api-key "your-key"
```

Exit with `Ctrl+C` twice. The provider is persisted in `.pi/settings.json`.

#### What happens under the hood

`./cheasee-pi.sh` runs `docker compose up` with:

- Image built from `docker/Dockerfile` (Debian 12-slim, Node.js 22, Python 3, ripgrep, ast-grep, pi, gosu)
- Repo root bind-mounted to `/workspaces/main` inside the container
- `.agent_env` file mounted and sourced automatically
- Host UID/GID mapped to container user `agentuser` (no permission issues with bind mounts)
- Interactive TTY for the Pi TUI

---

### 5. Orientation — What did I just install?

#### 5.1 Architecture

```
┌────────────────────────────────────────────────────┐
│  Terminal (Docker)                                  │
│  ┌──────────────────────────────────────────────┐  │
│  │  Pi TUI (Terminal) — cheasee-pi theme       │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │  │
│  │  │ Exts     │ │ AI Prov │ │ Rich Footer  │ │  │
│  │  │ .pi/     │ │OpenCode  │ │branch model  │ │  │
│  │  │ exts/    │ │Go/...    │ │tokens TPS    │ │  │
│  │  └───┬──────┘ └──────────┘ └──────────────┘ │  │
│  │      │                                        │  │
│  └──────┼────────────────────────────────────────┘  │
└─────────┼───────────────────────────────────────────┘
          │
     ┌────▼────────────────────────────┐
     │  External tools                  │
     │  ┌──────────┐ ┌───────────────┐ │
     │  │ ast-grep │ │ web-search    │ │
     │  │structural│ │ DuckDuckGo    │ │
     │  │_search   │ │ (ddgs)        │ │
     │  └──────────┘ └───────────────┘ │
     │  ┌──────────┐ ┌───────────────┐ │
     │  │ ripgrep  │ │ scrapling    │ │
     │  │ripgrep_  │ │Python venv    │ │
     │  │search    │ │(zero-browser) │ │
     │  └──────────┘ └───────────────┘ │
     └─────────────────────────────────┘
```

**Key principle:** All tools run locally. Web crawling runs on host (network-only for crawl). ast-grep, ripgrep are system binaries invoked via `pi.exec()`. No MCP servers, no network-exposed tool endpoints.

#### 5.2 Why extensions instead of MCP?

This project deliberately avoids the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). All tools are **pi extensions** — TypeScript files in `.pi/extensions/` that run inside the agent's Node.js runtime. No external MCP servers, no network-exposed tool endpoints, no separate processes.

**Two reasons: security and token efficiency.**

**🔒 Security:** MCP servers introduce a new attack surface (OWASP maintains the [MCP Top 10](https://owasp.org/www-project-mcp-top-10/)). Extensions treat tool execution as a function call. No network layer = no network attack surface.

**📉 Token Efficiency:** MCP servers expose full JSON Schema tool descriptions to the LLM on every request. Pi extensions use **prompt snippets** — concise one-line descriptions (~50-120 tokens vs ~300-800 for MCP). Full schema is only loaded when the tool is actually called. Saves thousands of tokens per turn.

#### 5.3 What's in the box — File Manifest

| File/Path                                           | What it is                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `.pi/extensions/structural-analyzer/`              | `structural_search` tool via ast-grep                                                                                  |
| `.pi/extensions/ripgrep-search/`                    | `ripgrep_search` tool via ripgrep (modular: args, config, parse, temp, validate)                                       |
| `.pi/extensions/scrapling/`                         | `web_crawl` tool: Scrapling with progressive fetching (lightweight → stealth)                                           |
| `.pi/extensions/web-search/`                        | `web_search` tool: DuckDuckGo search via ddgs Python lib — ranked results with URLs + snippets                         |
| `.pi/extensions/supervisor/`                        | Kanban-driven multi-agent orchestration                                                                                |
| `.pi/extensions/context-info/`                      | Rich TUI status bar (branch, model, tokens, TPS, cache, cache hit rate, session name, trust status), welcome banner |
| `.pi/extensions/session-logger/`                    | Session logging to JSONL                                                                                               |
| `.pi/extensions/agent-harness/`                     | Runtime tool call validation — blocks `bash                                                                            | grep`, `cat` file reads, redundant reads, error retry loops, same-tool cascades |
| `.pi/extensions/ask-user/`                          | Interactive MC questions + CSV logger                                                                                  |
| `.pi/extensions/caveman/`                           | Token-efficient communication protocol; mode-adaptive compression, project-trust gating, `/caveman status` command    |
| `.pi/extensions/format-on-save/`                    | Auto Prettier + ESLint after write/edit; trust-gated (skips on untrusted projects), mode-adaptive notifications (TUI: ui.notify, RPC: followUp, JSON/print: silent) |
| `.pi/extensions/lsp-auditor/`                       | LSP diagnostics pre-audit for supervisor                                                                               |
| `.pi/extensions/piignore.ts`                        | `.piignore` path blocking                                                                                              |
| `.pi/extensions/tsc-checkpoint.ts`                  | `/check` command: `tsc --noEmit`                                                                                       |
| `.pi/extensions/session-advice/`                    | Session advice — improvement recommendations per session                                                               |
| `.pi/extensions/check-extensions/`                  | `/check-extensions` — AST-based extension audit with migration snippets + impact scoring; trust-gated (skips on untrusted projects with guidance), mode-adaptive notifications (TUI: ui.notify, other: sendMessage structured messages) |
| `.pi/extensions/worktree-sandbox/`                  | Enforces agents operate only within assigned git worktree (path rewriting, cd enforcement)                             |
| `.pi/extensions/supervisor/agents/researcher.md`    | Researcher agent (pipeline step 1)                                                                                     |
| `.pi/extensions/supervisor/agents/architect.md`     | Architect agent (pipeline step 2)                                                                                      |
| `.pi/extensions/supervisor/agents/test-designer.md` | TestDesigner agent (pipeline step 3)                                                                                   |
| `.pi/extensions/supervisor/agents/developer.md`     | Developer agent (pipeline step 4)                                                                                      |
| `.pi/extensions/supervisor/agents/auditor.md`       | Auditor agent (pipeline step 5)                                                                                        |

| `.pi/settings.json`                                 | Supervisor + context status bar config                                                                                 |
| `.pi/themes/cheasee-pi.json`                       | Dark cyberpunk TUI theme                                                                                               |
| `.pi/prompts/requirement/`                          | Prompt templates: issue-cutter, issue-refinement (layer labels, Socratic refinement)                                   |
| `.pi/prompts/development/`                          | Prompt templates: handover, pr-review, quiz-master (session handoff, PR review, quiz auto-merge)                       |
| `.pi/prompts/operations/`                           | Prompt templates: model-select, package-extension, architecture-review, changelog-check, extension-validation          |
| `.pi/prompts/misc/`                                 | Prompt template: writing-voice (consistent AI writing style)                                                            |
| `.piignore`                                         | Agent path blocking (gitignore syntax)                                                                                 |
| `AGENTS.md`                                         | Caveman protocol (active every session)                                                                                |

| `Makefile`                                          | Docker workflow: `make up` (build+start), `make shell` (enter container), `make pi` (launch agent)                     |
| `test/`                                             | Unit/integration test files (4 test files)                                                                              |

| `.pi/state/session-extensions.json`                 | Tracks extension on/off state                                                                                          |

| `.pi/npm/`                                          | Local npm package cache                                                                                                |
| `flask_blogs/`                                      | Submodule: Flask blog apps                                                                                             |

#### 5.4 Extensions Deep Dive

Pi auto-discovers extensions from `.pi/extensions/` in the **project root**. No config file needed. No `--extension` flag.

| Extension               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Structural Analyzer** | `structural_search` via ast-grep. AST-aware pattern matching (function calls, try/catch, class defs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Ripgrep Search**      | `ripgrep_search` via ripgrep. Fast literal/regex code search, respects `.gitignore`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Supervisor**          | Kanban-driven multi-agent pipeline. Reads issue from GitHub project, dispatches agents in loop. Registers `/supervisor <issue-number>` command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Web Crawler**         | `web_crawl`: Scrapling with progressive fetching (lightweight curl_cffi → Playwright stealth). Auto-installs venv via pip install scrapling[fetchers] markdownify. |
| **Web Search**          | `web_search`: DuckDuckGo search via `ddgs` Python library. Ranked results with titles, URLs, snippets. Result cache (5-min TTL). Graceful degradation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Context Info**        | Rich TUI status bar (branch, model, tokens, TPS, cache), welcome banner, animated working indicator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Session Logger**      | Logs sessions to `.pi/sessions/<id>.jsonl`. Generates `.md` reports with sub-agent output from supervisor pipeline. Toggle with `/session-logger`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Session Advice**      | Analyzes each session after shutdown for inefficient patterns. Generates `.advice.md` with fix recommendations. Report with `/session-advice report`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Agent Harness**       | Runtime tool call validation via `agent-harness` extension. Blocks `bash` with `grep`/`rg` (redirects to `ripgrep_search`), `bash` with `cat`/`head`/`tail` (redirects to `read`). Caches reads to prevent redundant file reads. Tracks errors per tool to block retry loops (2+ errors). Tracks consecutive same-tool calls to break cascades (8+) with sub-command-aware detection (`git status` vs `git diff` tracked separately). Cascade resets per conversation turn — each LLM response cycle starts fresh. Bash cascade suggestion is context-aware: commands already using `&&` get "Reduce per-turn call count", non-`&&` commands get "Combine bash calls with &&". **Mode-aware read cache**: In non-TUI modes (CI/headless, where `hasUI=false`), read-cache blocks are bypassed to prevent stalls. **Project config**: `.pi/harness-config.json` can override tool thresholds and cascade settings, gated by project trust (`ctx.isProjectTrusted()`). Complements Session Advice (post-hoc) with runtime prevention. |
| **Caveman Protocol**    | Token-efficient communication. Active via `AGENTS.md`. Configurable intensity levels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Ask User**            | Interactive MC picker for AI-to-user questions. Uses arrow-key navigation + CSV logging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Format on Save**      | Auto-formats TS/JS with Prettier + ESLint --fix after write/edit. Non-blocking lint warnings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **PiIgnore**            | Blocks paths matching `.piignore` patterns from read/write/edit/bash. Supports negation (`!`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **TSC Checkpoint**      | `/check` command runs `tsc --noEmit` on worktree. Used in pipeline Implementation→Audit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Check Extensions**    | `/check-extensions` parses pi CHANGELOG.md, scans `.pi/extensions/` with **ast-grep AST analysis** (replacing regex grep). Classifies findings by context (runtime-call, import-type, import-value). Filters false positives via call-arg comparison. Generates migration snippets and impact scores per extension. Creates GitHub issues with `extension-audit` label.                                                                                                                                                                                                                                                                                                                                                                       |
| **Worktree Sandbox**    | Enforces developer/auditor agents operate ONLY within assigned git worktree. Intercepts read/write/edit/bash — rewrites relative paths, blocks absolute paths outside worktree. Deterministic enforcement (tool input mutation before execution). Activated by `WORKTREE_SANDBOX_PATH` env var.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **LSP Auditor**         | Runs real LSP diagnostics on modified files before merge. Groups by server, auto-retry (max 3). Called by supervisor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

#### 5.5 Agent Definitions

Agents are Markdown files in `.pi/extensions/supervisor/agents/` with YAML frontmatter. The supervisor reads them at runtime.

| Agent            | File               | Tools                                                      | Skills                  |
| ---------------- | ------------------ | ---------------------------------------------------------- | ----------------------- |
| **Researcher**   | `researcher.md`    | read, bash, structural_search, ripgrep_search              | —                       |
| **Architect**    | `architect.md`     | read, bash, structural_search, ripgrep_search              | `extension-spec`        |
| **TestDesigner** | `test-designer.md` | read, bash, structural_search, ripgrep_search              | —                       |
| **Developer**    | `developer.md`     | read, bash, write, edit, structural_search, ripgrep_search | `extension-spec`        |
| **Auditor**      | `auditor.md`       | read, bash, structural_search, ripgrep_search              | `duplicate-code-hunter` |

All agents use `opencode-go/deepseek-v4-flash` model. Developer additionally uses format-on-save and tsc-checkpoint extensions.

#### 5.6 Git Worktrees

Cheasee-Pi uses [git worktrees](https://git-scm.com/docs/git-worktree) to give each issue its **own isolated working directory** with its own branch. This keeps `main` clean and prevents agents from interfering with each other.

**Key concepts:**

- A worktree is a separate checkout of the repo at a different path (default: `../worktree-git-issue-<number>-<title-slug>/`)
- Each worktree has its own branch — changes in one worktree never affect another
- Worktrees share the same Git object store (no wasted disk space for history)
- The supervisor pipeline creates worktrees before dispatching the Developer agent
- Worktrees are cleaned up after the pipeline completes (success, failure, or stop)

**Worktree paths:** All worktrees live **outside** the main repo directory (one level up by default, configurable via `supervisor.worktreeBase` in `.pi/settings.json`).

**Lifecycle at a glance:**

```
1. Supervisor:  git worktree add -b <branch> ../<branch> main
2. Developer:   Works inside worktree, commits, pushes
3. Auditor:     Reviews diff via git diff main inside worktree
4. Supervisor:  git worktree remove --force ../<branch> (post-pipeline)
```

**Crash cleanup:** If the pipeline is terminated via SIGTERM (orchestrator) or SIGINT (Ctrl+C), signal handlers registered before the pipeline loop call `cleanupWorktree` automatically. An `isCleaningUp` guard prevents concurrent cleanup from a second signal. A 10-second timeout with `.unref()` prevents hanging on stalled `git worktree remove`. Errors are logged via the debug logger. Signals are unregistered in the `finally` block so they never leak beyond a pipeline run.

**Working with worktrees manually (outside supervisor):**

```bash
# Create a worktree for feature work
git worktree add -b feature/my-feature ../feature-my-feature main

# Work in it
cd ../feature-my-feature
git add -A && git commit -m "feat: my feature"
git push origin feature/my-feature

# Remove when done
cd /home/miria/git/main
git worktree remove --force ../feature-my-feature
git worktree prune
git branch -D feature/my-feature
```

**Why worktrees over branches alone?** Switching branches in-place means committing or stashing unfinished work. Worktrees let you have multiple branches checked out simultaneously — switch between contexts instantly.

**Tip:** The agent footer shows the worktree name in brackets next to the branch when inside a git worktree, so you always know where you are.

#### 5.7 Prompt Templates

Invocable via `/name` in Pi's editor. Files stored in `.pi/prompts/` organized by category:

| Template              | Usage                              | What it does                                                                                                                                                                                 |
| --------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **issue-cutter**      | `/issue-cutter <number>`           | Split epic into ordered, testable sub-issues with layer labels. Auto-links children to parent via GraphQL.                                                                                   |
| **issue-refinement**  | `/issue-refinement <number>`       | Grill issue against codebase, Socratic interview via `ask_user` (≥3 MC options), replace body with concrete ACs.                                                                             |
| **handover**          | `/handover`                        | Write handover doc summarizing conversation. Saves to `tmp/` with datetime prefix.                                                                                                           |
| **pr-review**         | `/pr-review`                       | Automated PR security/quality checks, validates against Cheasee-Pi philosophy, formats structured review comment.                                                                            |
| **quiz-master**       | `/quiz-master`                     | List open PRs across repo + submodules, quiz reviewer on diff with MC questions, auto-merge if score ≥80%.                                                                                   |
| **model-select**      | `/model-select <objective>`        | Research + recommend models per agent role. Crawls providers, benchmarks, pricing. Three objectives: cost-optimized, performance-optimized, balanced.                                         |
| **package-extension** | `/package-extension`               | Package selected extension from monorepo as individual npm pi-package. Sets up package.json with pi manifest, guides through publishing.                                                     |
| **architecture-review** | `/architecture-review`           | Audit codebase architecture against Clean Architecture + PEAA principles. Identifies violations, proposes refactors.                                                                         |
| **changelog-check**   | `/changelog-check`                 | Analyze pi CHANGELOG.md for breaking changes affecting extensions. Generates migration report.                                                                                               |
| **extension-validation** | `/extension-validation <path>`  | Validate extension structure, imports, hooks against pi extension API.                                                                                                                      |
| **writing-voice**     | `/writing-voice`                   | Derive consistent AI writing voice from sample text (paste, URL, or file). Generates `voice-{lang}.md` style guide.                                                                         |

#### 5.8 Tool Benchmark

Empirical token consumption comparing tool configurations on a real audit task ("Audit test coverage of chart/figure generation methods in `flask_planhead/app/services/`"). 5 runs per config.

| Config | Avg In | Avg Out | Avg Total | Avg Cost | Avg Duration |
|--------|--------|---------|-----------|----------|-------------|
| 1 — no tools | 1,351 | 1,272 | 2,623 | $0.00055 | 13.5s |
| 2 — structural-only | 15,231 | 5,075 | 178,438 | $0.00400 | 62.3s |
| 3 — structural + ripgrep | 13,769 | 5,850 | 177,700 | $0.00401 | 67.6s |

**Key takeaways:**
- **No-tools** cheap ($0.0005 avg) but agent can't do task — thin/empty results.
- **Structural-analyzer** massively improves quality. Cost ~$0.004/run, duration ~62s.
- **Adding ripgrep** (config 3) doesn't significantly change token count or cost vs structural-only for this task. Structural-analyzer handles needed patterns.
- **All tool configs** show high variance in input tokens (different exploration paths). Duration more stable than token count.

The agent footer also shows a **TPS (tokens-per-second)** gauge during streaming, computed from a rolling 30s window, plus **LLM prompt cache** stats (`📦 cacheRead/cacheWrite`) on Row 2 — toggle with `contextStatusBar.showCache` in `.pi/settings.json` (default `true`). The supervisor subagent footer shows cache stats next to the token count. Shows `📦 --/--` before the first assistant response.



#### 5.9 Published Pi Packages

Selected extensions from Cheasee-Pi are published as individual npm packages under the `@cheasee-pi` scope. They appear on the [pi.dev package gallery](https://pi.dev/packages) and install via `pi install`.

| Package                            | What it is                                                                                             | Install                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `@cheasee-pi/ask-user`            | Interactive ask_user tool with typed dialogs, Q&A log, and `/qna` command                              | `pi install npm:@cheasee-pi/ask-user`            |
| `@cheasee-pi/ripgrep-search`      | Fast literal/regex code search — respects `.gitignore`, structured file:line:column:text output        | `pi install npm:@cheasee-pi/ripgrep-search`      |
| `@cheasee-pi/lsp-auditor`         | Pre-audit code quality via LSP before commit — diagnostics on changed files                            | `pi install npm:@cheasee-pi/lsp-auditor`         |
| `@cheasee-pi/piignore`            | Blocks AI access to sensitive files via `.piignore` patterns — keeps secrets safe                      | `pi install npm:@cheasee-pi/piignore`            |
| `@cheasee-pi/structural-analyzer` | AST-aware code search via ast-grep — finds function calls, classes, try/catch, and structural patterns | `pi install npm:@cheasee-pi/structural-analyzer` |

**Why publish separately?** Not all extensions belong on pi.dev — some are Cheasee-Pi-specific (supervisor, session-logger, context-info). Published packages are self-contained, useful in any Pi setup.

**Package structure:** Each published extension has its own `package.json` with `keywords: ["pi-package"]` and a `pi` manifest pointing to its entry file. The README.md renders as the pi.dev detail page. The `package.json` `description` feeds the gallery card.

**Load only what you need:** Users can filter via `settings.json` object form:

```json
{
	"packages": [
		{
			"source": "npm:@cheasee-pi/ask-user",
			"extensions": ["./index.ts"]
		}
	]
}
```

Or after install, run `pi config` to enable/disable individual extensions.

### Publishing a Package

To publish an extension as an npm pi-package, use the `/package-extension` command in Pi's editor:

```
/package-extension
```

This runs the **Extension Packager** prompt which:

1. Lists all extensions in `.pi/extensions/`
2. Asks which one to package
3. Reads the code to discover imports and dependencies
4. Creates `package.json` with `@cheasee-pi/` scope, `pi-package` keyword, and pi manifest
5. Creates `README.md` (renders as pi.dev gallery detail page)
6. Shows `npm publish` commands to run manually
7. Updates this Published Pi Packages table

**Prerequisites:**

- npm account with `@cheasee-pi` org access ([create org](https://www.npmjs.com/org/create) if needed)
- Logged in: `npm login` / `npm whoami`
- If 2FA enabled: `npm publish --otp=<code>` or use a granular access token with bypass

**Manual publish:**

```bash
cd .pi/extensions/<name>
npm publish --access public
```

After publish, verify on [pi.dev/packages](https://pi.dev/packages) and test with `pi install npm:@cheasee-pi/<name>`.

#### 5.10 Skills

Currently **5 skills installed**:

| Skill                     | Purpose                                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **dead-code-hunter**      | Systematic dead code detection — finds unused exports, unreachable paths, dead branches, orphaned imports. Hunt loop picks random extension, validates with deterministic proof.                               |
| **extension-bug-hunter**  | Systematic bug hunting — boundary analysis, type safety, error paths, concurrency, input validation, security. Hunt loop with three-strike proof.                                                              |
| **extension-spec**        | Designs pi extensions — new or refactoring — with full PRD, TypeScript best practices, anti-pattern audit, migration plan.                                                                                     |
| **duplicate-code-hunter** | Systematic duplicate code detection — exact clones (Type 1), renamed clones (Type 2), near-miss (Type 3), semantic clones (Type 4). Uses jscpd for token-based scanning. Hunt loop with three-way-match proof. |
| **writing-voice**         | Derive consistent AI writing voice from sample text (paste, URL, or file). Generates `voice-{lang}.md` style guide. Applied before drafting any user-facing prose.                                              |

Skills are loaded on-demand via `/skill:<name>` invocation. Every skill's description injects ~50-150 tokens into the context window on every turn, causing [context rot](https://docs.anthropic.com/en/docs/build-with-claude/context-windows). Use sparingly. Prefer extensions (concise prompt snippets) or prompt templates (lazy-loaded) over skills.

---

### 6. Verification — Does everything work?

All checks run inside the container (after `./cheasee-pi.sh`).

#### 6.1 Environment

```bash
echo $APIFY_TOKEN   # Should print your token
```

#### 6.2 Tool Verification

```bash
# Structural search — find symbols, function/class definitions, AST patterns
pi "Use structural_search to find all console.log calls in TypeScript files"

# Text search — literal patterns, TODOs, error messages
pi "Use ripgrep_search to find 'TODO' in the project"

# Web search (auto-creates venv + installs ddgs on first call)
pi "Use web_search to find 'latest rust web framework 2026' with maxResults=5"
```

#### 6.3 Pi Autonomy

```bash
pi "Respond with exactly one word: 'Operational'."
```

#### 6.4 Execution Routing (Acid Test)

```bash
pi -p "Create a file named '.pi/test-file.txt' with the content 'container works', then tell me the absolute path where it was created."
```

**Expected:** `/workspaces/main/.pi/test-file.txt`

---

### 7. Daily Use — How to work with Cheasee-Pi

#### 7.1 Project Setup (one-time per GitHub project)

Create a GitHub Project (v2) with Kanban statuses from `.pi/settings.json`. Configure project number under `supervisor.projectNumber`.

Switch the project to **Board** layout in the browser and change **Group by** to `Workflow`.

#### 7.2 Daily Commands

| Action                  | Command                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Start session           | `pi`                                                                                 |
| Run supervisor pipeline | `/supervisor <issue-number>`                                                         |
| Run TSC type-check      | `/check`                                                                             |
| Toggle session advice   | `/session-advice on` / `/session-advice off`                                         |
| Session advice report   | `/session-advice report` — generates report, prompts cleanup + GitHub issue creation. Supports `--repo owner/repo` flag. Skips interactive dialogs in non-TUI modes.                                                               |
| Toggle session logger   | `/session-logger on` / `/session-logger off`                                         |
| Toggle caveman level    | `/caveman` (cycle: lite → full → off) or `/caveman lite`; `/caveman status` for prompt context; `/caveman config` for settings |
| Design an extension     | `/extension-spec <idea>`                                                             |
| Write handover          | `/handover`                                                                          |
| Quiz PR reviewer        | `/quiz-master`                                                                       |
| View session logs       | `ls .pi/sessions/`                                                                   |
| Reload config           | `/reload` (after editing .piignore, settings.json, etc.)                             |
| Toggle cache stats      | `"contextStatusBar": { "showCache": false }` in `.pi/settings.json`                  |

#### 7.3 Session Logger Details

Commands: `/session-logger`, `/session-logger on`, `/session-logger off`

Output formats:

- **JSONL log**: `.pi/sessions/<datetime>_<uuid>.jsonl` — event stream per session
- **Markdown report**: `.pi/sessions/<sessionId>.md` — human-readable session summary
- **Metadata**: `.pi/sessions/<sessionId>.metadata.json` — structured session metadata
- **Advice**: `.pi/sessions/<sessionId>.advice.md` — improvement recommendations (see 7.3b)
- **Latest symlinks**: `.pi/sessions/latest.*` — convenience symlinks to most recent report/metadata/advice

Each session produces uniquely-named `.md` and `.metadata.json` files (keyed by `sessionId`), so no data is overwritten between sessions.

The markdown report includes sub-agent output from supervisor pipeline agents
(developer, auditor, researcher, test-designer). Each sub-agent turn is rendered
with agent header, status, tool count, token count, duration, thinking blocks,
tool calls and results, raw output (collapsed), and audit score. Failed sub-agents
show error output. Sub-agent entries are clearly distinguished from primary
turns via `### Agent:` heading level.

Tool calls are formatted in native pi rendering style:
`$ command` for bash, `read /path:1-10` for read, `write /path (N lines)` for write,
`edit /path` for edit, `grep /pattern/` for search tools, `ls /path` for ls,
`find /path` for find. Unknown tools fall back to `toolName: JSON-args` format.

The report header includes the session **mode** (TUI, RPC, JSON, or print) when
available, distinguishing interactive sessions from automated and CI sessions.
If a session **name** was set via `--name`/`-n` CLI flag or `pi.setSessionName()`,
it appears in the report header between the start time and working directory
rows, enabling correlation between reports and named sessions.

**Project trust gate:** Session reports are generated only when the project is
trusted (`ctx.isProjectTrusted()` returns true). This prevents unintentional
tool argument and file path logging in untrusted projects. When a project is
not trusted, report generation is skipped and a warning notification is issued.

For recovered or crash-recovered sessions (where live session name and mode
are not available), the corresponding header rows are omitted — backward-
compatible with existing reports.

The JSONL log is a newline-delimited JSON event stream: messages, thinking blocks, tool calls, compactions.



#### 7.3b Session Advice

**Extension:** `session-advice` (`.pi/extensions/session-advice/`)

Detects inefficient patterns in each session and writes `.advice.md` alongside the session files.

**Patterns detected:**

| Pattern                    | Severity | Example                                                     |
| -------------------------- | -------- | ----------------------------------------------------------- |
| Tool mismatch              | error    | `bash \| grep` instead of `ripgrep_search`                  |
| Error not actioned         | error    | Tool errors, then retries same tool 4x                      |
| Identical call loop        | error    | Same tool+args 3x in last 12 calls                          |
| Same-tool cascade          | warning  | `bash` called 12x consecutively                             |
| Tool coverage gap          | warning  | Code files present but `structural_search` unused           |
| Structural-search underuse | warning  | 3+ code files read/edited, `structural_search` never called |
| Redundant reads            | warning  | Same file read within 2 turns                               |
| Excessive turns            | warning  | 20+ tool calls with no file changes                         |

**Feedback loop (before_agent_start):** On next session start, reads `latest.advice.md` and injects top 3 past findings as `⚠️ Past Session Lessons` into system prompt — agent learns from its own mistakes without manual intervention.

**Per-session advice** — automatic on session shutdown:

- `session_shutdown` hook generates `.advice.md` for the closing session
- `session_start` recovery generates advice for any past sessions missing it
- `latest.advice.md` symlink points to most recent advice
- `before_agent_start` injects past lessons into next session's system prompt

**Cross-session report** — manual, run via:

```
/session-advice report
```

Aggregates all sessions into `advice-report.md` with:

- Priority summary table (🔴 High / 🟡 Medium / 🟢 Low) with severity + example
- Per-category detail with sample findings, fix idea, effort estimate (Low/Medium/High)
- Per-session findings breakdown

After report generation, user is prompted to **clean up** the sessions folder (delete raw `.jsonl`, `.md`, `.metadata.json`) and then asked whether to **create a GitHub issue** from the report in the project repo (read from `supervisor.repo` in `.pi/settings.json`). Report file is preserved.



#### 7.4 Context & Templates

| Type          | File                        | Behavior                                              |
| ------------- | --------------------------- | ----------------------------------------------------- |
| **Always-on** | `AGENTS.md` in project root | Concatenated and appended to system prompt every turn |
| **On-demand** | `.pi/prompts/*.md`          | Invoked manually via `/prompt-name` in Pi's editor    |

`AGENTS.md` contains the caveman protocol (communication style + tool routing) and **🛠 Tool Discipline** section (pre-call checklist, DO/DON'T table, error recovery procedure, batching triggers). Each agent `.md` in `.pi/extensions/supervisor/agents/` also has a role-specific Tool Discipline box at top. Active automatically every session.

---

### 8. Power User — The Multi-Agent Pipeline

The supervisor (`/supervisor <issue-number>`) is the heart of this harness. It takes a GitHub issue, runs it through 5 agent stages in a Kanban loop, creates git worktrees, runs quality gates, and creates pull requests — all autonomously.

#### 8.1 Pipeline Flow

```
     ┌─────────────────────────────────────────────────────────────────────────┐
     │                         GITHUB PROJECT BOARD                           │
     │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌─────────┐  │
     │  │ Research │ │Architect.│ │TestDesign│ │Implement.    │ │  Audit  │  │
     │  │          │ │          │ │          │ │              │ │         │  │
     │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘ └────┬────┘  │
     │       │             │            │              │              │       │
     └───────┼─────────────┼────────────┼──────────────┼──────────────┼───────┘
             │             │            │              │              │
    ┌────────▼────────┐ ┌──▼────────┐ ┌─▼───────────┐ │    ┌─────────▼──────┐
    │  Researcher     │ │ Architect │ │ TestDesigner │ │    │   Auditor      │
    │  crawls web     │ │ proposes  │ │ writes       │ │    │   reviews      │
    │  for best       │ │ target    │ │ test plan    │ │    │   implements   │
    │  practices,     │ │ architec- │ │ from archi-  │ │    │   creates PR   │
    │  lib versions,  │ │ ture      │ │ tecture      │ │    │   or rejects   │
    │  pitfalls       │ │           │ │              │ │    │                │
    └────────┬────────┘ └──┬────────┘ └─┬───────────┘ │    └────────┬───────┘
             │             │            │              │             │
             ▼             ▼            ▼              │             ▼
     GitHub Comment   GitHub Comment  GitHub Comment   │    GitHub Comment
     ## Research      ## Architectu-  ## Test Plan      │    ## Audit Approved
     Findings         re Approach                       │    + PR created
                                                        │
                        ┌───────────────────────────────┘
                        │
                        ▼
              ┌──────────────────────┐
              │  QUALITY GATES       │
              │  ┌────────────────┐  │
              │  │ TSC --noEmit   │──│──→ pass → continue
              │  │ (tsc-checkpoint)│  │     fail → back to Implementation
              │  └────────────────┘  │
              │  ┌────────────────┐  │
              │  │ LSP pre-audit  │──│──→ pass → continue
              │  │ (lsp-auditor)  │  │     fail → back to Implementation
              │  │                │  │     (max 3 retries)
              │  └────────────────┘  │
              └──────────────────────┘
                        │
                        ▼
              ┌──────────────────────┐
              │  Auditor decision    │
              │  ┌──────────────┐    │
              │  │ APPROVED?    │──│──→ Yes → Create PR → DONE
              │  │              │    │     No  → back to Implementation
              │  └──────────────┘    │
              └──────────────────────┘
                        │
                        ▼
              ┌──────────────────────┐
              │  POST-PIPELINE       │
              │  Check PR for        │
              │  merge conflicts     │
              │  Auto-merge or       │
              │  dispatch Developer  │
              └──────────────────────┘
```

**Loop rules:**

- Each agent posts a structured GitHub comment on the issue
- Supervisor reads the agent's output for a **completion marker** to know the agent finished
- If agent times out, supervisor logs it and stops
- Auditor can reject → sends back to Implementation (counts as 1 rejection)
- LSP/TSC errors → sends back to Implementation (does NOT count as rejection, max 3 retries)
- `maxRejections` (default 5) stops the loop to prevent infinite cycles
- `agentTokenBudget` sets a soft cap on total tokens per agent (0 = unlimited). When exceeded, the agent session is flagged and the pipeline stops without retrying.
- `maxToolCalls` sets a hard cap on tool invocations per agent (0 = unlimited). When exceeded, the agent is terminated and the pipeline stops.
- Both `agentTokenBudget` and `maxToolCalls` are configured under `supervisor` in `.pi/settings.json`.
  ```jsonc
  // .pi/settings.json
  {
  	"supervisor": {
  		"agentTokenBudget": 500000, // Optional, 0 = unlimited
  		"maxToolCalls": 30, // Optional, 0 = unlimited
  	},
  }
  ```

#### 8.2 Agent Deep Dive

| #   | Agent            | Entry Marker     | Output Format                                      | Tools                                                                                 | Thinking                                      | Role                                                                                                                  |
| --- | ---------------- | ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | **Researcher**   | `Research`       | JSON `{ action, agentName, summary, commentBody }` | read, bash, structural_search, ripgrep_search                                         | medium                                        | Crawls 3-5 web pages on issue topic, synthesizes findings. Posts `## Research Findings`. Never makes recommendations. |
| 2   | **Architect**    | `Architecture`   | JSON `{ action, agentName, summary, commentBody }` | read, bash, structural_search, ripgrep_search                                         | high                                          | Applies Clean Architecture, PEAA, Philosophy of Software Design principles. Proposes target architecture.             |
| 3   | **TestDesigner** | `TestDesign`     | JSON `{ action, agentName, summary, commentBody }` | read, bash, structural_search, ripgrep_search                                         | medium                                        | Writes test plan: unit, integration, characterization tests.                                                          |
| 4   | **Developer**    | `Implementation` | JSON `{ action, agentName, summary, commentBody }` | read, bash, write, edit, structural_search, ripgrep_search                            | low                                           | Implements code in pre-created worktree, commits, pushes. Handles submodule changes.                                  |
| 5   | **Auditor**      | `Audit`          | JSON `{ action: "APPROVED"                         | "REJECTED", agentName, summary, commentBody, prTitle, prBody, auditScore, findings }` | read, bash, structural_search, ripgrep_search | medium                                                                                                                | Reviews code against architecture + test plan. Creates PR if approved, or rejects with specifics. |

#### 8.3 Git Worktree Lifecycle

Each issue gets an **isolated git worktree**. This prevents agents from interfering with each other and keeps `main` clean.

**Branch naming:** `worktree-git-issue-<number>-<title-slug>` (e.g., `worktree-git-issue-42-add-user-authentication`)

**Worktree path:** `../worktree-git-issue-<number>-<title-slug>/`

**Lifecycle (supervisor-owned):**

```
1. Supervisor creates worktree before Developer dispatch
   └── git worktree add -b <branch> ../<branch> <defaultBranch>

2. Supervisor dispatches Developer agent with cwd=<worktree-path>
   └── Agent tools (write, edit, bash, read) resolve against worktree

3. Developer implements, commits, pushes (inside worktree via cwd)
   ├── git add -A
   ├── git commit -m "feat(#42): Add user auth"
   └── git push origin <branch>

4. Supervisor dispatches Auditor agent with same cwd=<worktree-path>
   └── git diff <defaultBranch>

5. On approval: Auditor creates PR
   └── gh pr create --repo owner/repo --base <defaultBranch> --head <branch> --title "feat(#42): ..." --body "Closes #42"

6. Post-pipeline: supervisor cleans up worktree
   ├── git worktree remove --force ../<branch>
   ├── git worktree prune
   └── git branch -D <branch>
```

**Key rules:**

- Worktree is created and owned by the supervisor pipeline — agents never create or remove worktrees
- Agent cwd is set to worktree path automatically — no `cd` needed in agent tasks
- All Git operations happen inside the worktree (tools resolve against cwd)
- Worktree persists across feedback loops (auditor reject → re-implement)
- Supervisor cleans up worktree after pipeline completes (success, failure, or stop)
- Configurable via `supervisor.worktreeBase` and `supervisor.branchPrefix` in `.pi/settings.json`

#### 8.4 Submodule Strategy

When the repo has submodules, the Developer works on **both repos simultaneously** using a **matched-branch pattern**:

```
Main repo (cheasee-pi)          Submodule (flask_blogs)
│                                │
├─ Branch: worktree-git-...     ├─ Branch: worktree-git-... (same name)
├─ Commit includes submodule    ├─ Actual code changes
│  pointer update (pinned SHA)  │
└───────────────────────────────┴───────────────────────────────
```

**Detailed workflow:**

```
## Issue #42 "Add user auth"

# 1. Create worktree for cheasee-pi
git worktree add ../worktree-git-issue-42-add-user-authentication main
cd ../worktree-git-issue-42-add-user-authentication

# 2. Init submodule (arrives in detached HEAD — by design)
git submodule update --init --recursive

# 3. Create matching branch in submodule (required before editing)
cd flask_blogs
git checkout -b worktree-git-issue-42-add-user-authentication
git push -u origin worktree-git-issue-42-add-user-authentication
cd ..

# 4. Developer edits files in cheasee-pi AND/OR flask_blogs/

# 5. Push submodule FIRST (critical order)
cd flask_blogs
git add -A && git commit -m "feat(#42): Add user auth"
git push origin worktree-git-issue-42-add-user-authentication
cd ..

# 6. Push cheasee-pi (includes submodule pointer update)
git add -A
git commit -m "feat(#42): Add user auth"
git push origin worktree-git-issue-42-add-user-authentication
```

**Why submodule must be pushed first:** The cheasee-pi commit records a specific submodule SHA. If that SHA only exists locally, teammates get `fatal: reference is not a tree`. The `push.recurseSubmodules check` config blocks the push if submodule commits haven't been pushed — a safety net, not a replacement for correct order.

**Why submodules start in detached HEAD:** Git submodules pin a specific commit, not a branch. `git submodule update` checks out that exact commit. You must explicitly checkout a branch to make editable changes — standard Git behavior.

**Result:** Two branches with same name exist:

- `cheasee-pi:worktree-git-issue-42-add-user-authentication`
- `flask_blogs:worktree-git-issue-42-add-user-authentication`

**Disk usage note:** Each worktree clones submodules independently (under `.git/worktrees/<name>/modules/`). Not shared across worktrees — known Git design tradeoff.

**Auditor PR creation order:**

```
Step 1 — Create submodule PR FIRST (if submodule has changes):
  cd flask_blogs
  gh pr create --repo owner/flask_blogs --base main --head <branch> --title "feat(#42): ..."

Step 2 — Create main repo PR SECOND (includes submodule pointer):
  gh pr create --repo owner/cheasee-pi --base main --head <branch> --title "feat(#42): ..." --body "Closes #42"
```

#### 8.5 Quality Gates

Before transitioning `Implementation → Audit`, the supervisor runs two checks on the worktree:

**1. TSC Checkpoint** (`tsc-checkpoint` extension)

- Runs `npx tsc --noEmit` on the worktree
- Only runs if `tsconfig.json` exists
- Non-blocking if tsc binary not found

**2. LSP Pre-Audit** (`lsp-auditor` extension)

- Runs real LSP diagnostics on **modified files only** (git diff vs `defaultBranch`)
- Groups files by language server (TypeScript, Python, ESLint, etc.)
- Each group audited concurrently via separate LSP server process
- Auto-retries on errors (max 3 attempts), exponential backoff
- Only blocks if LSP server is available AND reports errors

**Decision table:**

| TSC               | LSP          | Outcome                             |
| ----------------- | ------------ | ----------------------------------- |
| pass              | pass         | → Audit                             |
| pass              | fail         | → Implementation (retry LSP, max 3) |
| pass              | N/A (no LSP) | → Audit                             |
| fail              | (skipped)    | → Implementation                    |
| N/A (no tsconfig) | pass         | → Audit                             |

#### 8.6 Merge Conflict Resolution

After pipeline reaches `Done`, supervisor checks the created PR for merge conflicts:

```
PR created (pipeline done)
  └─ gh pr view ... --json mergeable
       ├─ No conflict → done
       └─ Conflict?
            └─ Ask user: fix? (ctx.ui.confirm)
                 ├─ Yes → auto-merge attempt (git merge base)
                 │    ├─ Success → git push → done
                 │    └─ Fail → dispatch Developer agent to resolve
                 └─ No → done
```

#### 8.7 GitHub Interaction

The supervisor interacts with GitHub on every step:

| Action                                          | Method  | Purpose                                               |
| ----------------------------------------------- | ------- | ----------------------------------------------------- |
| `gh issue view <N> --json ...`                  | pi.exec | Fetch issue data (pre-filtered to trusted codeowners) |
| `gh project view <projectNumber> ...`           | pi.exec | Get field IDs for status options                      |
| `gh project item-list <projectNumber> ...`      | pi.exec | Find issue's project item, read current status        |
| `gh api graphql ...` (set status)               | pi.exec | Move issue to next status on board                    |
| `gh issue comment <N> --repo <R> --body <B>`    | pi.exec | Agent posts structured comment                        |
| `gh pr create --repo <R> --base <B> --head <H>` | pi.exec | Auditor creates PR on approval                        |
| `gh pr view <branch> --json ...`                | pi.exec | Post-pipeline merge conflict check                    |

**Security:** All issue data is **pre-filtered** before reaching agents — only the body (if author is a codeowner) and comments from trusted codeowners are passed. The agent is explicitly instructed: "Use ONLY the issue data provided above. Do NOT run `gh issue view`." This prevents prompt injection via untrusted issue comments.

#### 8.8 Configuration Reference

All supervisor settings in `.pi/settings.json` under the `supervisor` key:

```jsonc
{
	"supervisor": {
		"repo": "SchneiderDaniel/cheasee-pi", // REQUIRED — owner/repo format
		"projectNumber": 3, // REQUIRED — GitHub Project (v2) number
		"statusMapping": {
			// REQUIRED — board status → agent file
			"Research": "researcher",
			"Architecture": "architect",
			"TestDesign": "test-designer",
			"Implementation": "developer",
			"Audit": "auditor",
		},
		"codeowners": ["SchneiderDaniel"], // REQUIRED — trusted GitHub usernames
		"statusField": "Status", // Single-select field on project board
		"maxRejections": 3, // Max Auditor rejections before loop stops
		"agentTokenBudget": 300000, // Soft token cap per agent (0 = unlimited)
		"bellOnComplete": false, // Bell sound when pipeline finishes
		"enableExperimentalFeatures": false, // Gate experimental pipeline features
	},
}

#### 8.9 Complete Walkthrough

Here's what happens end-to-end when you run `/supervisor 42`:

```
You: /supervisor 42

── Step 1: Fetch ────────────────────────────────────────────────
Supervisor reads .pi/settings.json → repo, project board, statuses
Fetches issue #42 from GitHub, filters to trusted codeowners only
Reads issue's current status from project board → "Research"

── Step 2: Researcher ───────────────────────────────────────────
Spins up agent with researcher system prompt + issue data
Agent crawls 3-5 web pages about the issue topic
Posts:  gh issue comment 42 --repo owner/repo --body "## Research Findings..."
Outputs: JSON `{"action":"COMPLETE","agentName":"researcher","commentBody":"## Research Findings..."}`
Supervisor parses JSON → moves issue → "Architecture" on board

── Step 3: Architect ────────────────────────────────────────────
Spins up agent with architect prompt + issue + research findings
Analyzes codebase using read, bash, structural_search, ripgrep_search
Proposes architecture following Clean Architecture + PEAA principles
Posts:  gh issue comment 42 --body "## Architecture Approach..."
Outputs: JSON `{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture..."}`
Supervisor parses JSON → moves issue → "TestDesign"

── Step 4: TestDesigner ─────────────────────────────────────────
Spins up agent with test-designer prompt + issue + architecture
Writes test plan: unit, integration, characterization tests
Posts:  gh issue comment 42 --body "## Test Plan..."
Outputs: JSON `{"action":"COMPLETE","agentName":"test-designer","commentBody":"## Test Plan..."}`
Supervisor parses JSON → moves issue → "Implementation"

── Step 5: Developer ────────────────────────────────────────────
Supervisor creates worktree:  git worktree add -b <branch> ../<branch> main
Spins up agent with developer prompt + issue + arch + test plan, cwd=<worktree-path>
  Implements feature, runs tests, formats code
  git add -A && git commit -m "feat(#42): ..."
  git push origin <branch>
Outputs: JSON `{"action":"COMPLETE","agentName":"developer","summary":"Implemented..."}`
Supervisor parses JSON → moves issue → "Implementation"→"Audit" via quality gates

── Step 6: Quality Gates ────────────────────────────────────────
  TSC: runs npx tsc --noEmit on worktree → pass
  LSP: runs diagnostics on modified files → pass
Supervisor moves issue → "Audit"

── Step 7: Auditor ──────────────────────────────────────────────
Spins up agent with auditor prompt + all previous data, cwd=<worktree-path>
  git diff main (reviews changes)
  Reviews against architecture + test plan
  Decision: APPROVED ✔
  Creates submodule PRs if needed
  Creates main PR: gh pr create --repo owner/repo --head <branch> --title "feat(#42): ..."
  Posts: ## Audit Approved
Outputs: JSON `{"action":"APPROVED","agentName":"auditor","prTitle":"feat(#42):...","auditScore":{"passing":6,"total":6},"findings":[]}`
Supervisor parses JSON → moves issue → "Done"

── Step 8: Post-pipeline ────────────────────────────────────────
  Checks PR for merge conflicts
  If conflicted → asks you if you want to auto-fix
  If yes → attempts auto-merge
  If auto-merge fails → dispatches Developer to resolve

── Done ─────────────────────────────────────────────────────────
Issue #42 is complete with a PR ready for final review.
```

> **Note:** The walkthrough above shows the updated pipeline: dependency gate, in-process agent execution (live TUI widget), architecture-before-research sequence, auditor summary file protocol, and post-pipeline merge conflict resolution.

#### 8.9 Error Aggregation

The supervisor pipeline uses a centralized `ErrorCollector` to aggregate all non-fatal errors and warnings. Instead of silent `console.warn` / `console.error` calls that the user never sees, every failure mode pushes a structured record to the collector:

- **Issue fetch failures** — GitHub API errors, stale data fallbacks
- **Agent comment posting failures** — GitHub comment API errors
- **Commit/push failures** — git errors during developer commit
- **Worktree cleanup failures** — git worktree remove/branch delete errors
- **PR creation failures** — push retries exhausted, PR create API errors
- **Pre-audit errors** — TSC/LSP check failures, CI polling errors
- **Subprocess errors** — agent runner heartbeat/JSON processing errors
- **Watchdog timeouts** — stalled session detection

**How it works:**

1. The pipeline creates an `ErrorCollector` instance at startup and threads it through all pipeline functions
2. Deeper layers (agent runner, session runner, stream parser) use a module-level singleton accessor
3. After each agent execution, if the collector has entries, a `supervisor-warnings` message is rendered
4. The final `supervisor-summary` message prepends the warnings block with grouped error/warning counts

**Warnings panel format:**

```
## ⚠️ Warnings

### helpers
- **[ERROR]** Issue #42 not found in owner/repo

### stages
- **[WARN]** Developer commentBody extracted from result.textOutput (fallback)

**1 error(s), 1 warning(s)** — see above for details.
```

This replaces silent `console.warn` / `console.error` calls across 12+ pipeline and agent files, ensuring every failure mode is visible to the user.

The `ErrorCollector` class (`pipeline/error-collector.ts`) provides:
- `push(source, severity, message)` — add a record
- `flush(source)` — retrieve and clear records by source
- `hasErrors()` — check if any records exist
- `toNotificationBlock()` — build markdown warnings panel

---

### 9. Troubleshooting — Something broke

#### Container doesn't start

Rebuild the image without cache:

```bash
docker compose build --no-cache
./cheasee-pi.sh
```

#### Web crawl fails with Chromium errors

The extension auto-installs system libraries inside the container. If it persists:

```bash
rm -rf .pi/scrapling-venv    # Next call auto-recreates
```

#### Permission errors on bind-mounted files

UID/GID mapping is automatic via `cheasee-pi.sh`. If you need to run manually:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up
```

#### `gh auth status` shows "not logged in"

Inside the container, run:

```bash
gh auth login
```

Authenticate with **Login with a web browser**.

#### `.piignore` blocking legitimate paths

Edit `.piignore` and add a negation pattern:

```
!path/to/allow
```

Reload: `/reload`

---

### 10. Contributing — I want to help

Contributions welcome — bug reports, feature requests, documentation improvements, new extensions.

1. Fork the repository
2. Create a feature branch (`git worktree add -b feature/amazing feature-amazing` is the recommended workflow)
3. Make your changes
4. Run tests: `npm test` (runs 4 test files in `test/`)
5. Submit a PR

---

## Appendix

### SBOM — Software Bill of Materials

| Component                                         | Version  | License      | Type       | Supplier/URL                                                                                             |
| ------------------------------------------------- | -------- | ------------ | ---------- | -------------------------------------------------------------------------------------------------------- |
| **Runtime & Core**                                |          |              |            |                                                                                                          |
| @earendil-works/pi-coding-agent                   | ^0.79.1  | MIT          | dev        | [pi.dev](https://pi.dev)                                                                                 |
| @earendil-works/pi-agent-core                     | ^0.79.1  | MIT          | transitive | [pi.dev](https://pi.dev)                                                                                 |
| @earendil-works/pi-ai                             | ^0.79.1  | MIT          | transitive | [pi.dev](https://pi.dev)                                                                                 |
| @silvia-odwyer/photon-node                        | 0.3.4    | MIT          | transitive | [github.com/silvia-odwyer/photon-node](https://github.com/silvia-odwyer/photon-node)                     |
| jiti                                              | 2.7.0    | MIT          | transitive | [github.com/unjs/jiti](https://github.com/unjs/jiti)                                                     |
| **AI Providers**                                  |          |              |            |                                                                                                          |
| @anthropic-ai/sdk                                 | 0.91.1   | MIT          | transitive | [anthropic.com](https://www.anthropic.com)                                                               |
| openai                                            | 6.26.0   | Apache-2.0   | transitive | [openai.com](https://openai.com)                                                                         |
| @aws-sdk/client-bedrock-runtime                   | 3.1041.0 | Apache-2.0   | transitive | [aws.amazon.com](https://aws.amazon.com)                                                                 |
| @aws-crypto/sha256-browser                        | 5.2.0    | MIT          | transitive | [aws.amazon.com](https://aws.amazon.com)                                                                 |
| **Schema & Validation**                           |          |              |            |                                                                                                          |
| typebox                                           | 1.1.37   | MIT          | transitive | [github.com/typebox/typebox](https://github.com/typebox/typebox)                                         |
| zod                                               | 4.4.2    | MIT          | transitive | [zod.dev](https://zod.dev)                                                                               |
| **Formatter**                                     |          |              |            |                                                                                                          |
| prettier                                          | ^3.8.3   | MIT          | dev        | [prettier.io](https://prettier.io)                                                                       |
| **TUI & UI**                                      |          |              |            |                                                                                                          |
| @earendil-works/pi-tui                            | ^0.79.1  | MIT          | prod       | [pi.dev](https://pi.dev)                                                                                 |
| boxen                                             | ^7.1.1   | MIT          | prod       | [github.com/sindresorhus/boxen](https://github.com/sindresorhus/boxen)                                   |
| **LSP**                                           |          |              |            |                                                                                                          |
| vscode-jsonrpc                                    | ^8.2.1   | MIT          | prod       | [github.com/microsoft/vscode-jsonrpc](https://github.com/microsoft/vscode-jsonrpc)                       |
| **TypeScript**                                    |          |              |            |                                                                                                          |
| typescript                                        | ^6.0.3   | Apache-2.0   | dev        | [typescriptlang.org](https://www.typescriptlang.org)                                                     |
| **Utilities**                                     |          |              |            |                                                                                                          |
| fast-xml-parser                                   | 5.7.2    | MIT          | transitive | [github.com/NaturalIntelligence/fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) |
| tslib                                             | 2.8.1    | 0BSD         | transitive | [github.com/microsoft/tslib](https://github.com/microsoft/tslib)                                         |
| yoctocolors                                       | 2.1.2    | MIT          | transitive | [github.com/sindresorhus/yoctocolors](https://github.com/sindresorhus/yoctocolors)                       |
| std-env                                           | 3.10.0   | MIT          | transitive | [github.com/unjs/std-env](https://github.com/unjs/std-env)                                               |
| **System Runtimes**                               |          |              |            |                                                                                                          |
| Node.js                                           | ≥22      | MIT          | system     | [nodejs.org](https://nodejs.org)                                                                         |
| Python 3                                          | ≥3.10    | PSF          | system     | [python.org](https://python.org)                                                                         |
| npm                                               | latest   | Artistic-2.0 | system     | [npmjs.com](https://npmjs.com)                                                                           |
| **Infrastructure Tools**                          |          |              |            |                                                                                                          |
| GitHub CLI (gh)                                   | latest   | MIT          | system     | [cli.github.com](https://cli.github.com)                                                                 |
| AST-grep                                          | ≥0.42    | MIT          | system     | [ast-grep.github.io](https://ast-grep.github.io)                                                         |
| ripgrep (rg)                                      | latest   | MIT          | system     | [github.com/BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep)                                   |
| jscpd                                             | 4.2.4    | MIT          | system     | [github.com/kucherenko/jscpd](https://github.com/kucherenko/jscpd)                                       |
| **Web Crawling (Python venv)**                    |          |              |            |                                                                                                          |
| scrapling                                         | latest   | MIT          | venv       | [github.com/nicofirst/scrapling](https://github.com/nicofirst/scrapling)                                 |
| Playwright Chromium                               | latest   | Apache-2.0   | venv       | [playwright.dev](https://playwright.dev)                                                                 |
| markdownify                                        | latest   | MIT          | venv       | [github.com/matthewwithanm/python-markdownify](https://github.com/matthewwithanm/python-markdownify)     |
| **Project Extensions (`.pi/extensions/`)**        |          |              |            |                                                                                                          |
| structural-analyzer/                            | —        | MIT          | project    | This repository                                                                                          |
| ripgrep-search/                                   | —        | MIT          | project    | This repository                                                                                          |
| caveman/                                          | —        | MIT          | project    | This repository                                                                                          |
| scrapling/                                        | —        | MIT          | project    | This repository                                                                                          |
| session-logger/                                   | —        | MIT          | project    | This repository                                                                                          |
| ask-user/                                         | —        | MIT          | project    | This repository                                                                                          |
| supervisor/                                       | —        | MIT          | project    | This repository                                                                                          |
| format-on-save/                                   | —        | MIT          | project    | This repository                                                                                          |
| context-info/                                     | —        | MIT          | project    | This repository                                                                                          |
| lsp-auditor/                                      | —        | MIT          | project    | This repository                                                                                          |
| piignore.ts                                       | —        | MIT          | project    | This repository                                                                                          |
| tsc-checkpoint.ts                                 | —        | MIT          | project    | This repository                                                                                          |
| **Project Skills (`.pi/skills/`)**                |          |              |            |                                                                                                          |
| dead-code-hunter/ (with references/)              | —        | MIT          | project    | This repository                                                                                          |
| extension-bug-hunter/ (with references/)          | —        | MIT          | project    | This repository                                                                                          |
| extension-spec/                                   | —        | MIT          | project    | This repository                                                                                          |
| duplicate-code-hunter/ (with references/)         | —        | MIT          | project    | This repository                                                                                          |
| writing-voice/ (with references/)                 | —        | MIT          | project    | This repository                                                                                          |

> **License Compliance:** All components use OSI-approved open-source licenses (MIT, Apache-2.0, 0BSD, PSF, Artistic-2.0). No GPL/AGPL copyleft. No proprietary or source-available licenses. Total transitive dependency count: ~256 packages (`npm ls --all`).
>
> **SBOM Generation:** This table is manually maintained. For automated CycloneDX/SPDX SBOM: `npx cyclonedx-npm` + `pip freeze | cyclonedx-py` in `.pi/scrapling-venv/`.

### Security

**Security properties:**

- ✅ No MCP servers — only pi extensions (no network-exposed tool servers)
- ✅ API keys loaded from `.agent_env` (repo root), never committed
- ✅ `.piignore` path blocking — block sensitive files from agent read/write/edit/bash
- ✅ **npm package age gate** — agent refuses to install npm packages < 14 days old (typosquatting protection)
- ✅ **Scope boundary enforcement** — pre-dispatch git diff check prevents agents from modifying files outside their issue scope. Issues with extension labels (e.g. `supervisor`, `agent-harness`) restrict file writes to `.pi/extensions/<name>/`. `documentation` label restricts to `*.md` files. No scope label = no restriction (backward compatible). Two-layer enforcement: hard git-diff gate in pipeline + prominent prompt injection.

### License

MIT © 2025. See [LICENSE](./LICENSE) for full text.

All third-party components are OSI-approved open source (see [SBOM](#sbom--software-bill-of-materials)).

### Acknowledgments

Built on top of these excellent projects:

**Runtime & Tools:**

- [Pi Coding Agent](https://pi.dev) — The agent runtime
- [scrapling](https://github.com/nicofirst/scrapling) — Memory-optimized web scraper with progressive fetching
- [Zed](https://zed.dev) — The editor

**Agent Best Practices:**

- [shanraisshan/claude-code-best-practice](https://github.com/shanraisshan/claude-code-best-practice) (52k ★) — Agentic engineering patterns, context management, sub-agent workflows
- [ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books) (1.3k ★) — AI agent rules distilled from classic software engineering books:
  - **Architect agent:** Clean Architecture (R. Martin), PEAA (M. Fowler), A Philosophy of Software Design (J. Ousterhout)
  - **Developer agent:** Clean Code (R. Martin), Code Complete (S. McConnell), The Pragmatic Programmer (Hunt & Thomas)
- [WoJiSama/skill-based-architecture](https://github.com/WoJiSama/skill-based-architecture) (224 ★) — AI agent rule system lifecycle
- [charles-adedotun/claude-code-sub-agents](https://github.com/charles-adedotun/claude-code-sub-agents) (30 ★) — Agent-architect bootstrapper pattern

**Communication & Workflow:**

- [Caveman](https://github.com/JuliusBrussee/caveman) — Token-efficient AI communication protocol
- [pi-caveman](https://github.com/jonjonrankin/pi-caveman) — Multi-level caveman mode for Pi
- [Matt Pocock's Skills — improve-codebase-architecture](https://github.com/mattpocock/skills/tree/main/skills/engineering/improve-codebase-architecture) — Architecture deepening methodology. Also inspiration for `issue-refinement` prompt pattern.

**Extensions & Tools:**

- [Pi SDK & Extensions Documentation](https://pi.dev/docs/latest) — Extension API, commands, hooks, theme system
- [ast-grep](https://ast-grep.github.io) — Structural code search via Tree-sitter AST
- [ripgrep](https://github.com/BurntSushi/ripgrep) — Ultra-fast literal/regex code search
