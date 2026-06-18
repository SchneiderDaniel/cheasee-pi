---
layout: default
title: Architecture
nav_order: 3
---

# Architecture

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## System overview

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

## Extensions vs MCP

This project deliberately avoids the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). All tools are **pi extensions** — TypeScript files in `.pi/extensions/` that run inside the agent's Node.js runtime. No external MCP servers, no network-exposed tool endpoints, no separate processes.

**Two reasons: security and token efficiency.**

**Security:** MCP servers introduce a new attack surface (OWASP maintains the [MCP Top 10](https://owasp.org/www-project-mcp-top-10/)). Extensions treat tool execution as a function call. No network layer = no network attack surface.

**Token efficiency:** MCP servers expose full JSON Schema tool descriptions to the LLM on every request. Pi extensions use **prompt snippets** — concise one-line descriptions (~50-120 tokens vs ~300-800 for MCP). Full schema is only loaded when the tool is actually called. Saves thousands of tokens per turn.

## Git Worktrees

Cheasee-Pi uses [git worktrees](https://git-scm.com/docs/git-worktree) to give each issue its **own isolated working directory** with its own branch. This keeps `main` clean and prevents agents from interfering with each other.

### Key concepts

- A worktree is a separate checkout of the repo at a different path
- Each worktree has its own branch — changes never affect another worktree
- Worktrees share the same Git object store (no wasted disk space)
- The supervisor pipeline creates worktrees before dispatching the Developer agent
- Worktrees are cleaned up after the pipeline completes

### Lifecycle

```
1. Supervisor:  git worktree add -b <branch> ../<branch> main
2. Developer:   Works inside worktree, commits, pushes
3. Auditor:     Reviews diff via git diff main inside worktree
4. Supervisor:  git worktree remove --force ../<branch>
```

### Manual worktree usage

```bash
# Create a worktree
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

### Why worktrees?

Switching branches in-place means committing or stashing unfinished work. Worktrees let you have multiple branches checked out simultaneously — switch between contexts instantly.

## Why extensions instead of MCP?

This project deliberately avoids the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). All tools are **pi extensions** — TypeScript files in `.pi/extensions/` that run inside the agent's Node.js runtime. No external MCP servers, no network-exposed tool endpoints, no separate processes.

**Two reasons: security and token efficiency.**

**Security:** MCP servers introduce a new attack surface (OWASP maintains the [MCP Top 10](https://owasp.org/www-project-mcp-top-10/)). Extensions treat tool execution as a function call. No network layer = no network attack surface.

**Token efficiency:** MCP servers expose full JSON Schema tool descriptions to the LLM on every request. Pi extensions use **prompt snippets** — concise one-line descriptions (~50-120 tokens vs ~300-800 for MCP). Full schema is only loaded when the tool is actually called. Saves thousands of tokens per turn.

## Multi-agent pipeline

The supervisor orchestrates a 5-step pipeline:

```
Researcher → Architect → TestDesigner → Developer → Auditor
```

Each agent is a Markdown file in `.pi/extensions/supervisor/agents/` with YAML frontmatter defining tools, skills, and model.

| Agent            | Tools                                                      | Skills                  |
| ---------------- | ---------------------------------------------------------- | ----------------------- |
| **Researcher**   | read, bash, structural_search, ripgrep_search              | —                       |
| **Architect**    | read, bash, structural_search, ripgrep_search              | `extension-spec`        |
| **TestDesigner** | read, bash, structural_search, ripgrep_search              | —                       |
| **Developer**    | read, bash, write, edit, structural_search, ripgrep_search | `extension-spec`        |
| **Auditor**      | read, bash, structural_search, ripgrep_search              | `duplicate-code-hunter` |

## Submodule strategy

When the repo has submodules, the Developer works on **both repos simultaneously** using a **matched-branch pattern**:

```
Main repo (cheasee-pi)          Submodule (flask_blogs)
│                                │
├─ Branch: worktree-git-...     ├─ Branch: worktree-git-... (same name)
├─ Commit includes submodule    ├─ Actual code changes
│  pointer update (pinned SHA)  │
└───────────────────────────────┴───────────────────────────────
```

**Submodule must be pushed first** because the main repo commit records a specific submodule SHA. If that SHA only exists locally, teammates get `fatal: reference is not a tree`.

**PR creation order:**
1. Create submodule PR first (if submodule has changes)
2. Create main repo PR second (includes submodule pointer)

## Docker container

The container is built from `docker/Dockerfile` (Debian 12-slim) and includes:

- Node.js 22
- Python 3
- ripgrep
- ast-grep
- Pi coding agent
- gosu (for UID/GID mapping)

The repo root is bind-mounted at `/workspaces/main`. `.agent_env` is sourced for API keys. Host UID/GID are mapped to container user `agentuser`.
