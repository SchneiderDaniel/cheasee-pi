---
layout: default
title: Methodology
nav_order: 6
---

# Methodology

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Kanban-driven pipeline

Cheasee-Pi uses a **GitHub Project board** (v2) to orchestrate autonomous development. The pipeline runs 5 agents in sequence:

```
Researcher → Architect → TestDesigner → Developer → Auditor
```

Each agent reads the current issue, produces output, and moves the GitHub Project card to the next status column. The pipeline loops until the issue reaches `Done`.

### Agent flow

1. **Researcher** — Investigates the codebase, gathers context, identifies affected files
2. **Architect** — Designs the solution, validates against architecture principles
3. **TestDesigner** — Plans test coverage, writes test cases
4. **Developer** — Implements the solution, runs TSC check
5. **Auditor** — Reviews changes via LSP diagnostics, checks for code quality

### Project board setup

Create a GitHub Project (v2) with these statuses:

```
Todo → In Progress → Review → Done
```

Configure the project number in `.pi/settings.json` under `supervisor.projectNumber`. Use **Board** layout with **Group by** set to `Workflow`.

## Security-first design

### No MCP servers

All tools are pi extensions running inside the agent's Node.js runtime. No external MCP servers, no network-exposed endpoints, no separate processes.

**Why:** MCP servers introduce network attack surface (OWASP [MCP Top 10](https://owasp.org/www-project-mcp-top-10/)). Extensions treat tool execution as a function call. No network layer = no network attack surface.

### PiIgnore

The `.piignore` file blocks agent access to sensitive paths. Uses gitignore-style patterns. Blocks read/write/edit/bash operations on matched paths.

### Agent Harness

Runtime validation intercepts dangerous patterns before execution:
- Blocks `bash | grep` / `bash | rg` — redirects to `ripgrep_search`
- Blocks `bash cat` / `head` / `tail` — redirects to `read`
- Prevents error retry loops (2+ errors on same tool blocks further calls)
- Breaks same-tool cascades (8+ consecutive calls)

### Worktree Sandbox

Agents in the pipeline operate only within their assigned git worktree. Paths are rewritten, operations outside the worktree are blocked.

## Token efficiency

### Prompt snippets vs MCP schemas

Pi extensions use **prompt snippets** — concise one-line descriptions (~50-120 tokens). MCP exposes full JSON Schema (~300-800 tokens) on every request. Full extension schema is only loaded when the tool is actually called.

### Caveman protocol

Active every session via `AGENTS.md`. Compresses communication by dropping articles, filler words, and pleasantries. Configurable levels: lite (professional but tight), full (fragments), off (verbose).

### Session advice

Post-session analysis detects inefficient patterns:
- Tool mismatches (`bash | grep` instead of `ripgrep_search`)
- Identical call loops (same tool+args repeated)
- Redundant reads (same file within 2 turns)
- Tool coverage gaps (structural_search unused when reading code)
- Excessive turns (20+ calls with no file changes)

Past findings are injected into the next session's system prompt automatically.

## Daily workflow

### Typical session

1. Start with `pi`
2. Select or create a GitHub issue
3. Run `/supervisor <issue-number>` to start the pipeline
4. Monitor progress via TUI status bar
5. Review results when pipeline completes

### Configuration

Key files:
- `.pi/settings.json` — Supervisor config, TUI options, model selection
- `.pi/harness-config.json` — Tool thresholds and cascade settings
- `.piignore` — Path blocking rules
- `AGENTS.md` — Always-on system prompt additions
