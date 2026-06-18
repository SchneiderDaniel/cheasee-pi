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

| Package | Version | Purpose |
|---------|---------|---------|
| `@ast-grep/cli` | — | AST-aware code search |
| `typescript` | — | TypeScript compiler, type checking |
| `prettier` | — | Code formatting |
| `eslint` | — | Code linting |

## System dependencies

| Tool | Version | Purpose |
|------|---------|---------|
| Docker Engine | ≥24.0 | Container runtime |
| Docker Compose | V2 | Multi-container orchestration |
| Node.js | 22 | JavaScript runtime |
| Python | 3 | Web scraping, search tools |
| ripgrep (rg) | — | Fast code search |
| git | — | Version control, worktrees |
| gosu | — | UID/GID mapping in container |

## Python packages

| Package | Purpose |
|---------|---------|
| `scrapling[fetchers]` | Web crawling with progressive fetching |
| `markdownify` | HTML to Markdown conversion |
| `ddgs` | DuckDuckGo search API |

## Pi extensions

| Extension | Type | Purpose |
|-----------|------|---------|
| `structural-analyzer` | Core tool | AST-aware code search |
| `ripgrep-search` | Core tool | Fast text/regex search |
| `scrapling` | Core tool | Web crawling |
| `web-search` | Core tool | DuckDuckGo search |
| `supervisor` | Pipeline | Kanban multi-agent orchestration |
| `context-info` | UX | Rich TUI status bar |
| `session-logger` | UX | Session logging to JSONL |
| `session-advice` | UX | Post-session pattern analysis |
| `agent-harness` | Safety | Runtime tool call validation |
| `caveman` | Communication | Token-efficient protocol |
| `ask-user` | Interaction | Interactive MC questions |
| `format-on-save` | DX | Auto formatting |
| `piignore` | Safety | Path blocking |
| `tsc-checkpoint` | DX | TypeScript type checking |
| `check-extensions` | DX | Extension compatibility audit |
| `worktree-sandbox` | Safety | Worktree path enforcement |
| `lsp-auditor` | Pipeline | LSP diagnostics pre-audit |

## Docker image base

- **Base image:** Debian 12-slim (bookworm)
- **Image name:** `cheasee-pi`
- **Build context:** `docker/Dockerfile`
