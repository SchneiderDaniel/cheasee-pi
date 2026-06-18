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
| `.pi/extensions/session-logger/` | Session logging to JSONL + Markdown |
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

---

## Agent Harness

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/agent-harness/README.md)

**Why.** Every incorrect tool call costs tokens. Every error loop burns context window. Agent Harness intercepts tool calls and blocks wasteful patterns before they execute: `bash | grep` → redirects to `ripgrep_search`, error retries blocked after 2 consecutive failures, same-tool cascades blocked after 8+ calls, redundant reads return cached results within 6 turns.

**How it works.** Hooks into pi's `tool_call` event and runs each call through a 7-step validation pipeline: pass-through check → error tracking → cache invalidation on writes → error retry guard → read caching → cascade detection (8+ consecutive) → tool mismatch blocks. Configurable via `.pi/harness-config.json` with per-tool thresholds.

## Ask User

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/ask-user/README.md)

**Why.** The LLM needs decisions, preferences, or clarifications — instead of hallucinating defaults, it calls `ask_user` and you respond through a structured dialog. Supports multiple-choice and free-text modes.

**How it works.** Two tools registered: `ask_user` (choice/freetext modes with mode-adaptive UI) and `ask_user_read` (retrieve past Q&A by id, list, or text search). All interactions saved to `.pi/context/qna.jsonl`. Trust-gated persistence — history only written when project trust is granted. Includes `/qna` command for browsing history.

## Caveman Protocol

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/caveman/README.md)

**Why.** Reduces response token count 30-50% by dropping articles, filler words, pleasantries, and hedging from all agent output. Active every session via `AGENTS.md`.

**How it works.** Reads config from `~/.pi/agent/caveman.json`, checks `AGENTS.md` for session level override. Three intensity levels: lite (professional, tight sentences), full (fragments, no articles), off. Mode-adaptive — skips compression in JSON/RPC modes to avoid mangling structured output. Injects rules into system prompt via `before_agent_start`. Cycle with `/caveman` command.

## Check Extensions

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/check-extensions/README.md)

**Why.** Pi releases can break extensions. This extension automates auditing all `.pi/extensions/` against pi's CHANGELOG — detects removed APIs, renamed hooks, signature changes, and generates migration snippets with GitHub issues.

**How it works.** Triggered via `/check-extensions` (trust-gated). Parses pi CHANGELOG.md for breaking entries, scans each extension with ast-grep AST analysis, cross-references API usage against changes, scores impact severity, and generates structured GitHub issues with old→new code migration.

## Context Info

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/context-info/README.md)

**Why.** Replaces pi's default footer with a rich dashboard: git branch, model name, token usage with color thresholds, TPS during streaming, cache hit rate, session name, trust status, thinking level, live timer, and tool call counter.

**How it works.** Creates `FooterState` on session start, reads config from `.pi/settings.json`. Renders custom footer via `ctx.ui.setFooter()`. Updates reactively on `model_select`, `thinking_level_select`, `turn_end`, `message_end`, `message_update`, `tool_execution_end` events. Timer updates session duration every second. Cleaned up on session shutdown. Also registers `/explain-extensions`, `/explain-prompts`, `/explain-skills` commands.

## Format on Save

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/format-on-save/README.md)

**Why.** Auto-formats TS/JS files with Prettier and runs ESLint diagnostics after every `write` or `edit` — no manual step needed. Catches code quality issues early, before the supervisor Audit stage.

**How it works.** Hooks `tool_result` events for write/edit. Checks file existence, size (<5MB), and project trust. Runs Prettier formatter then ESLint linter asynchronously. TUI mode shows toast notifications, RPC sends `followUp` messages, JSON/print stay silent. Non-blocking — errors don't crash the session.

## LSP Auditor

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/lsp-auditor/README.md)

**Why.** Runs real Language Server Protocol diagnostics on changed files before code review — catches errors, warnings, and hints that the LLM might miss. Called automatically by the supervisor pipeline during the Audit stage.

**How it works.** Triggered manually via `/lsp-auditor` or automatically by supervisor. Uses `git diff` to find changed files, groups by file extension (`.ts` → `typescript-language-server`, `.py` → `pylsp`, etc.), spawns LSP servers, opens files via `didOpen`, collects `publishDiagnostics`. Filters by per-server severity threshold. Retries up to 3 times. Trust-gated — untrusted projects skip LSP audit.

## PiIgnore

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/piignore/README.md)

**Why.** Blocks AI from accessing sensitive paths using `.piignore` patterns (gitignore format). Intercepts `read`, `write`, `edit`, `bash`, and other tools. Trust model: when untrusted, uses hardcoded safe-defaults instead of attacker-controlled `.piignore`.

**How it works.** Loads `.piignore` files walking up from project root to filesystem root. On every tool call, checks target paths against loaded patterns. Bash commands are tokenized with shell-aware parsing — URLs, package names, echo/printf strings are excluded from path checking. Pattern reload on `/reload`. Global companion extension warns about overly broad patterns before trust is granted.

## Ripgrep Search

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/ripgrep-search/README.md)

**Why.** Fast literal/regex code search that respects `.gitignore`, returns structured summaries with match counts, file counts, and truncation info. Falls back to `grep` if ripgrep unavailable.

**How it works.** Registers `ripgrep_search` tool. Validates queries (rejects structural patterns → redirects to `structural_search`). Runs ripgrep with `--vimgrep` for structured output, or grep with `-rnH` as fallback. Results cached in memory by (query, directory). TUI mode renders clickable `file://` hyperlinks. Mode-adaptive output — non-TUI modes skip ANSI/OSC8 sequences.

## Scrapling (Web Crawl)

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/scrapling/README.md)

**Why.** Crawl web pages behind Cloudflare and extract content as Markdown. Progressive fetching: starts lightweight (`curl_cffi`), escalates to Playwright stealth when blocked. Auto-installs Python venv on first call.

**How it works.** Registers `web_crawl` tool. On first call, creates `.pi/scrapling-venv/` with `scrapling[fetchers]` and `markdownify`. Validates URL, acquires concurrency semaphore (max 2 concurrent), runs Python subprocess. Progressive fetching: lightweight curl_cffi → Playwright stealth on Cloudflare block. Extracts Markdown via `markdownify`, truncates by `maxTokens`. Returns `--- URL (via method) ---\ncontent` formatted results.

## Session Advice

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/session-advice/README.md)

**Why.** After every session, analyzes the JSONL log for wasteful patterns — tool mismatches, error loops, redundant reads, cascade cascades — and generates `.advice.md` with fix recommendations. Past lessons are auto-injected into the next session's system prompt.

**How it works.** On session shutdown, reads `.jsonl` and runs 10+ waste signal detectors (`bash-grep`, `bash-cat`, `error-loop`, `identical-args`, `redundant-reads`, `structural-underuse`, `no-batch`, `turn-inefficiency`). Generates `latest.advice.md` with severity labels and concrete examples. On next `before_agent_start`, reads the advice file, extracts top 3 actions, and appends to system prompt. `/session-advice report` generates aggregate waste report across all sessions and can create GitHub issues.

## Session Logger

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/session-logger/README.md)

**Why.** Generates rich Markdown reports alongside pi's `.jsonl` session files — per-turn token breakdown, tool execution stats, file modifications, sub-agent output, and error summaries.

**How it works.** Hooks into session lifecycle (`session_start`, `session_shutdown`), turn events (`turn_start`, `turn_end`), message events (`message_end`), and tool events (`tool_execution_start`, `tool_execution_end`, `tool_call`). Tracks token in/out per turn, thinking tokens, tool execution duration, file modifications. On shutdown, writes `.md` and `.metadata.json` alongside `.jsonl`. Toggle with `/session-logger`. Trust-gated — only generates reports on trusted projects.

## Structural Analyzer

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/structural-analyzer/README.md)

**Why.** AST-aware code pattern search via ast-grep — finds function calls, class definitions, try/catch blocks, method invocations without noise from comments or strings. Prevents "find definitions by grep" anti-pattern.

**How it works.** Registers `structural_search` tool with S-expression and code-snippet pattern syntax (`$META_VAR` for single nodes, `$$$MULTI` for zero-or-more). Optional language parameter auto-detects from project config files. Rejects single-word text patterns (redirects to `ripgrep_search`). Results cached by (pattern, language, cwd). Streaming for >100 matches. TUI renders clickable `file://` hyperlinks.

## Supervisor

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/supervisor/README.md)

**Why.** Autonomous Kanban pipeline driving 5 agents (Researcher → Architect → TestDesigner → Developer → Auditor) through GitHub Project board status transitions. Creates worktrees, manages quality gates, creates PRs. Full development lifecycle automation.

**How it works.** Triggered via `/supervisor <issue-number>`. Reads config from `.pi/settings.json` (repo, project number, status mapping, codeowners). Fetches GitHub issue, creates worktree at `.worktrees/feature-N/`. Dispatches agents per board status — each agent reads its definition from `.pi/extensions/supervisor/agents/<agent>.md` (YAML frontmatter defining tools, skills, model). Posts results as GitHub comments, moves board cards. Quality gates: TSC type-check + LSP diagnostics between Implementation and Audit. Auditor approves/rejects; rejected issues cycle back to Implementation (max 5 rejections). Creates PR on approval. Supports submodules with matched-branch pattern.

## TSC Checkpoint

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/tsc-checkpoint/README.md)

**Why.** Incremental TypeScript type-checking with watch mode. First `/check` spawns the compiler; subsequent calls return cached diagnostics instantly. Tracks error trends (regression/improvement/stable). Used by supervisor pipeline as quality gate.

**How it works.** Triggered via `/check`. Checks project trust and `tsconfig.json` existence. Lazy-initializes `DiagnosticsWatcher` wrapping TypeScript's watch compiler API. `watcher.start()` creates `ts.createWatchProgram()`. `watcher.getDiagnostics()` returns current cached diagnostics. `watcher.getTrend()` compares current vs previous error count. TUI: markdown with `file://` paths. JSON: structured `{ files: [...] }`. Watcher stopped on session shutdown.

## Web Search

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/web-search/README.md)

**Why.** Web search via DuckDuckGo metasearch engine — returns ranked results with titles, URLs, snippets. Designed to discover URLs for follow-up crawling with `web_crawl`. Result cache with 5-minute TTL.

**How it works.** Registers `web_search` tool. On first call, auto-creates `.pi/web-search-venv/` and installs `ddgs`. Each call writes Python script to per-call isolated temp dir (`ignore/web-search/search-<random>/`) to prevent file races. Executes via `pi.exec` bash subprocess. Results parsed from `SEARCH_OK`/`SEARCH_DONE` delimiters. Cached in memory (5-min TTL). Errors propagate as thrown exceptions for proper `isError` signaling.

## Worktree Sandbox

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/worktree-sandbox/README.md)

**Why.** Enforces agents operate ONLY within their assigned git worktree — deterministic enforcement at the tool call boundary, not prompt-level. Blocks `cd` escape via variables, tilde expansion, command substitution, pipe prefix bypasses, and shell redirects outside worktree.

**How it works.** Activated by setting `WORKTREE_SANDBOX_PATH` env var. Hooks `tool_call`: `read`/`write`/`edit` rewrite relative paths to worktree root, block absolute paths outside. `bash` prepends `cd "<worktree>" && ` to every command. Shell-aware parsing via `shell-quote` detects `cd` escape vectors (variable expansion → `<HOME>`, tilde → `hasShellExpansion()`, pipe prefix → `isCommandStart()`). Also blocks file writes via redirect (`>`, `>>`), `cp`/`mv`/`touch` destinations outside worktree. Trust gate prevents attacker-controlled env var from redirecting sandbox.

---

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
