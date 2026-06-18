---
layout: default
title: SBOM
nav_order: 8
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
| `@ast-grep/cli` | — | MIT | AST-aware code search |
| `typescript` | ^6.0.3 | Apache-2.0 | TypeScript compiler |
| `prettier` | ^3.8.3 | MIT | Code formatting |
| `boxen` | ^7.1.1 | MIT | TUI box rendering |
| `vscode-jsonrpc` | ^8.2.1 | MIT | LSP communication |

## System dependencies

| Tool | Version | License | Purpose |
|------|---------|---------|---------|
| Docker Engine | ≥24.0 | Apache-2.0 | Container runtime |
| Docker Compose | V2 | Apache-2.0 | Multi-container orchestration |
| Node.js | ≥22 | MIT | JavaScript runtime |
| Python 3 | ≥3.10 | PSF | Web scraping, search tools |
| ripgrep (rg) | latest | MIT | Fast code search |
| ast-grep | ≥0.42 | MIT | Structural code search |
| GitHub CLI (gh) | latest | MIT | GitHub API client |
| jscpd | 4.2.4 | MIT | Duplicate code detection |
| git | — | GPL-2.0 | Version control, worktrees |
| gosu | — | Apache-2.0 | UID/GID mapping in container |

## Python packages (venv)

| Package | License | Purpose |
|---------|---------|---------|
| `scrapling[fetchers]` | MIT | Web crawling with progressive fetching |
| `markdownify` | MIT | HTML to Markdown conversion |
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
| `session-advice` | UX | Post-session pattern analysis + feedback |
| `agent-harness` | Safety | Runtime tool call validation |
| `caveman` | Communication | Token-efficient protocol |
| `ask-user` | Interaction | Interactive MC questions + CSV logging |
| `format-on-save` | DX | Auto Prettier + ESLint after write/edit |
| `piignore` | Safety | Path blocking via `.piignore` |
| `tsc-checkpoint` | DX | TypeScript type checking |
| `check-extensions` | DX | Extension compatibility audit |
| `worktree-sandbox` | Safety | Worktree path enforcement |
| `lsp-auditor` | Pipeline | LSP diagnostics pre-audit |

## Docker image base

- **Base image:** Debian 12-slim (bookworm)
- **Image name:** `cheasee-pi`
- **Build context:** `docker/Dockerfile`
