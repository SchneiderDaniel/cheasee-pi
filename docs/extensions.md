---
layout: default
title: Extensions
nav_order: 4
---

# Extensions

{: .no_toc }

Pi auto-discovers extensions from `.pi/extensions/` in the project root. No config file needed. No `--extension` flag.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## File manifest

| File/Path | What it is |
|-----------|------------|
| `.pi/extensions/structural-analyzer/` | `structural_search` via ast-grep |
| `.pi/extensions/ripgrep-search/` | `ripgrep_search` via ripgrep |
| `.pi/extensions/scrapling/` | `web_crawl` via Scrapling |
| `.pi/extensions/web-search/` | `web_search` via ddgs |
| `.pi/extensions/supervisor/` | Kanban multi-agent orchestration |
| `.pi/extensions/context-info/` | Rich TUI status bar |
| `.pi/extensions/session-logger/` | Session logging to JSONL |
| `.pi/extensions/session-advice/` | Post-session pattern analysis |
| `.pi/extensions/agent-harness/` | Runtime tool call validation |
| `.pi/extensions/ask-user/` | Interactive MC questions |
| `.pi/extensions/caveman/` | Token-efficient protocol |
| `.pi/extensions/format-on-save/` | Auto Prettier + ESLint |
| `.pi/extensions/lsp-auditor/` | LSP diagnostics pre-audit |
| `.pi/extensions/piignore.ts` | Path blocking |
| `.pi/extensions/tsc-checkpoint.ts` | `/check` command |
| `.pi/extensions/check-extensions/` | Extension compatibility audit |
| `.pi/extensions/worktree-sandbox/` | Worktree path enforcement |
| `.pi/settings.json` | Supervisor + TUI config |
| `.pi/themes/cheasee-pi.json` | Dark cyberpunk TUI theme |
| `.pi/prompts/requirement/` | Issue-cutter, issue-refinement |
| `.pi/prompts/development/` | Handover, pr-review, quiz-master |
| `.pi/prompts/operations/` | Model-select, package-extension, etc. |
| `.pi/prompts/misc/` | writing-voice |
| `.piignore` | Agent path blocking |
| `AGENTS.md` | Caveman protocol (active every session) |
| `Makefile` | Docker workflow |

## Agent definitions

Agents are Markdown files in `.pi/extensions/supervisor/agents/` with YAML frontmatter. The supervisor reads them at runtime.

| Agent | File | Tools | Skills |
|-------|------|-------|--------|
| **Researcher** | `researcher.md` | read, bash, structural_search, ripgrep_search | — |
| **Architect** | `architect.md` | read, bash, structural_search, ripgrep_search | `extension-spec` |
| **TestDesigner** | `test-designer.md` | read, bash, structural_search, ripgrep_search | — |
| **Developer** | `developer.md` | read, bash, write, edit, structural_search, ripgrep_search | `extension-spec` |
| **Auditor** | `auditor.md` | read, bash, structural_search, ripgrep_search | `duplicate-code-hunter` |

All agents use `opencode-go/deepseek-v4-flash` model. Developer additionally uses format-on-save and tsc-checkpoint.

## Core tools

### Structural Analyzer

`structural_search` via ast-grep. AST-aware pattern matching for finding function/class definitions, method calls, try/catch blocks, and structural code patterns.

- **Location:** `.pi/extensions/structural-analyzer/`
- **npm:** `@cheasee-pi/structural-analyzer`

### Ripgrep Search

`ripgrep_search` via ripgrep. Fast literal/regex code search, respects `.gitignore`. Returns structured output with file paths, line numbers, and snippets.

- **Location:** `.pi/extensions/ripgrep-search/`
- **npm:** `@cheasee-pi/ripgrep-search`

### Web Crawler

`web_crawl` via Scrapling with progressive fetching (lightweight curl_cffi → Playwright stealth). Auto-installs venv on first call. Automatic Cloudflare bypass.

- **Location:** `.pi/extensions/scrapling/`

### Web Search

`web_search` via DuckDuckGo Python library (`ddgs`). Ranked results with titles, URLs, snippets. Result cache with 5-min TTL. Graceful degradation.

- **Location:** `.pi/extensions/web-search/`

## Multi-agent pipeline

### Supervisor

Kanban-driven multi-agent orchestration. Reads issue from GitHub Project board, dispatches agents in a 5-step pipeline. Registers `/supervisor <issue-number>` command.

- **Location:** `.pi/extensions/supervisor/`

### LSP Auditor

Real LSP diagnostics on modified files before merge. Groups by server, auto-retry (max 3). Called by supervisor pipeline.

- **Location:** `.pi/extensions/lsp-auditor/`
- **npm:** `@cheasee-pi/lsp-auditor`

### Worktree Sandbox

Enforces developer/auditor agents operate ONLY within assigned git worktree. Intercepts read/write/edit/bash — rewrites relative paths, blocks absolute paths outside worktree. Deterministic enforcement via tool input mutation before execution.

- **Location:** `.pi/extensions/worktree-sandbox/`

## Developer experience

### Context Info

Rich TUI status bar showing branch, model, tokens, TPS, cache stats, cache hit rate, session name, trust status. Welcome banner and animated working indicator.

- **Location:** `.pi/extensions/context-info/`

### Session Logger

Logs sessions to `.pi/sessions/<id>.jsonl`. Generates `.md` reports with sub-agent output. Toggle with `/session-logger`.

- **Location:** `.pi/extensions/session-logger/`

### Session Advice

Analyzes each session after shutdown for inefficient patterns. Generates `.advice.md` with fix recommendations. Injects past lessons into next session's system prompt automatically.

- **Location:** `.pi/extensions/session-advice/`

### Format on Save

Auto-formats TypeScript/JavaScript with Prettier + ESLint --fix after every write/edit. Trust-gated, mode-adaptive notifications.

- **Location:** `.pi/extensions/format-on-save/`

### TSC Checkpoint

`/check` command runs `tsc --noEmit` on the worktree. Used in pipeline Implementation → Audit transition.

- **Location:** `.pi/extensions/tsc-checkpoint.ts`

## Safety & compliance

### Agent Harness

Runtime tool call validation. Blocks `bash` with `grep`/`rg` (redirects to `ripgrep_search`), `bash` with `cat`/`head`/`tail` (redirects to `read`). Caches reads to prevent redundant file reads. Tracks errors per tool to block retry loops. Breaks same-tool cascades.

- **Location:** `.pi/extensions/agent-harness/`

### PiIgnore

Blocks paths matching `.piignore` patterns from read/write/edit/bash. Supports gitignore-style negation (`!`).

- **Location:** `.pi/extensions/piignore.ts`
- **npm:** `@cheasee-pi/piignore`

### Caveman Protocol

Token-efficient communication protocol. Mode-adaptive compression with project-trust gating. Active via `AGENTS.md`. Configurable intensity levels (lite / full / off).

- **Location:** `.pi/extensions/caveman/`

### Check Extensions

`/check-extensions` parses pi CHANGELOG.md, scans `.pi/extensions/` with ast-grep AST analysis, finds compatibility issues, generates migration snippets.

- **Location:** `.pi/extensions/check-extensions/`

### Ask User

Interactive multiple-choice picker for AI-to-user questions. Arrow-key navigation. CSV logging for audit trail.

- **Location:** `.pi/extensions/ask-user/`
- **npm:** `@cheasee-pi/ask-user`

## Published packages

Selected extensions are published as npm packages under the `@cheasee-pi` scope. They appear on the [pi.dev package gallery](https://pi.dev/packages).

| Package | What it is | Install |
|---------|------------|--------|
| `@cheasee-pi/ask-user` | Interactive ask_user tool with typed dialogs, Q&A log, `/qna` command | `pi install npm:@cheasee-pi/ask-user` |
| `@cheasee-pi/ripgrep-search` | Fast literal/regex code search — respects `.gitignore`, structured output | `pi install npm:@cheasee-pi/ripgrep-search` |
| `@cheasee-pi/lsp-auditor` | Pre-audit code quality via LSP before commit | `pi install npm:@cheasee-pi/lsp-auditor` |
| `@cheasee-pi/piignore` | Blocks AI access to sensitive files via `.piignore` patterns | `pi install npm:@cheasee-pi/piignore` |
| `@cheasee-pi/structural-analyzer` | AST-aware code search via ast-grep | `pi install npm:@cheasee-pi/structural-analyzer` |

**Why publish separately?** Not all extensions belong on pi.dev — some are Cheasee-Pi-specific (supervisor, session-logger, context-info). Published packages are self-contained, useful in any Pi setup.

**Package structure:** Each published extension has its own `package.json` with `keywords: ["pi-package"]` and a `pi` manifest pointing to its entry file.

### Publishing a package

Use the `/package-extension` command in Pi's editor to package an extension for npm. The command:

1. Lists all extensions in `.pi/extensions/`
2. Reads the code to discover imports and dependencies
3. Creates `package.json` with `@cheasee-pi/` scope, `pi-package` keyword
4. Creates `README.md`
5. Shows `npm publish` commands to run manually
