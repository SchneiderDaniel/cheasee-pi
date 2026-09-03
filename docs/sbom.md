---
layout: default
title: SBOM
nav_order: 10
---

# Software Bill of Materials

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Node packages

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| `@earendil-works/pi-coding-agent` | ^0.79.1 | MIT | Pi agent runtime |
| `@earendil-works/pi-ai` | ^0.79.1 | MIT | Pi API client |
| `@earendil-works/pi-tui` | ^0.79.1 | MIT | Pi TUI runtime |
| `@ast-grep/cli` | — | MIT | AST-aware code search |
| `typescript` | ^6.0.3 | Apache-2.0 | TypeScript compiler |
| `prettier` | ^3.8.3 | MIT | Code formatting |
| `boxen` | ^7.1.1 | MIT | TUI box rendering |
| `proper-lockfile` | ^4.1.2 | MIT | File-based locking for session logs |
| `shell-quote` | ^1.9.0 | MIT | Shell command parsing for worktree sandbox |
| `typebox` | ^1.2.8 | MIT | Runtime type validation |
| `js-yaml` | ^5.2.2 | MIT | YAML parsing (dev, release tests) |
| `vscode-jsonrpc` | ^8.2.1 | MIT | LSP communication |
| `zod` | ^4.4.3 | MIT | Schema-driven config validation |
| `@octokit/rest` | ^22.0.1 | MIT | GitHub REST API client (supervisor pipeline) |
| `@octokit/graphql` | ^8.2.1 | MIT | GitHub GraphQL API client (supervisor pipeline) |

## Go modules (cheasee-pi CLI)

| Module | Version | License | Purpose |
|--------|---------|---------|---------|
| `charm.land/huh/v2` | v2.0.3 | MIT | Terminal UI forms |
| `github.com/cli/oauth` | v1.2.2 | MIT | Device-flow OAuth for GitHub auth |
| `github.com/go-git/go-git/v5` | v5.19.1 | Apache-2.0 | Git repository operations |
| `github.com/spf13/cobra` | v1.10.2 | Apache-2.0 | CLI framework |
| `golang.org/x/mod` | v0.40.0 | BSD-3-Clause | Go module utilities |

## System dependencies

| Tool | Version | License | Purpose |
|------|---------|---------|---------|
| Docker Engine | ≥24.0 | Apache-2.0 | Container runtime |
| Docker Compose | V2 | Apache-2.0 | Multi-container orchestration |
| Go | ≥1.25 | BSD-3-Clause | Build language for the cheasee-pi CLI |
| Node.js | ≥22 | MIT | JavaScript runtime |
| Python 3 | ≥3.10 | PSF | Web scraping, search tools |
| ripgrep (rg) | latest | MIT | Fast code search |
| ast-grep | ≥0.42 | MIT | Structural code search |
| GitHub CLI (gh) | latest | MIT | GitHub API client |
| jscpd | 4.2.4 | MIT | Duplicate code detection |
| osv-scanner | v2.4.0 | Apache-2.0 | Vulnerability scanning (audit pipeline) |
| eslint | latest | MIT | JS/TS linting (extension checks) |
| pyright | latest | MIT | Python type checking |
| rust-analyzer | latest | MIT/Apache-2.0 | Rust LSP server |
| gopls | latest | BSD-3-Clause | Go LSP server |
| typescript-language-server | latest | MIT | TypeScript LSP server |
| fd-find | latest | MIT/Apache-2.0 | Fast file search (`fd`) |
| universal-ctags | latest | GPL-2.0 | Code index for tag generation |
| jq | latest | MIT | JSON processor for shell scripts |
| unzip | latest | Info-ZIP | Archive extraction |
| wget | latest | GPL-3.0 | HTTP file download |
| git | — | GPL-2.0 | Version control, worktrees |
| gosu | — | Apache-2.0 | UID/GID mapping in container |

## Python packages (venv)

| Package | License | Purpose |
|---------|---------|---------|
| `scrapling[fetchers]` | MIT | Web crawling with progressive fetching |
| `markdownify` | MIT | HTML to Markdown conversion |
| `beautifulsoup4` | MIT | HTML parsing (scrapling dependency) |
| `ddgs` | MIT | DuckDuckGo search API |
| Playwright Chromium | Apache-2.0 | Browser automation for web crawling |

## Pi extensions

| Extension | Type | Purpose |
|-----------|------|---------|
| `structural-analyzer` | Core tool | AST-aware code search via ast-grep |
| `ripgrep-search` | Core tool | Fast text/regex search via ripgrep |
| `scrapling` | Core tool | Web crawling with Cloudflare bypass |
| `web-search` | Core tool | DuckDuckGo search |
| `supervisor` | Pipeline | Kanban multi-agent orchestration |
| `context-info` | UX | Rich TUI status bar |
| `session-logger` | UX | Session logging to JSONL |
| `agent-harness` | Safety | Runtime tool call validation |
| `caveman` | Communication | Token-efficient protocol |
| `ask-user` | Interaction | Interactive MC/freetext questions + JSONL logging |
| `format-on-save` | DX | Auto Prettier + ESLint after write/edit |
| `tsc-checkpoint` | DX | TypeScript type checking |
| `worktree-sandbox` | Safety | Worktree path enforcement |
| `rtk` | Core tool | Token-saving bash rewrite via `rtk` binary (60-90% less output) |
| `lsp-auditor` | Pipeline | LSP diagnostics pre-audit |
| `zzz-dump-context` | Debug | System prompt capture + dump |

## Docker image base

- **Base image:** Debian 12-slim (bookworm)
- **Image name:** `cheasee-pi`
- **Build context:** `cmd/cheasee-pi/embedded/docker/Dockerfile` (canonical source, embedded via `//go:embed` and extracted to a cache dir at runtime)
