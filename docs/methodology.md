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

### Pipeline flow

```
     ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌─────────┐
     │ Research │ │Architect.│ │TestDesign│ │Implement.    │ │  Audit  │
     └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘ └────┬────┘
          │             │            │              │              │
    ┌─────▼──────┐ ┌───▼──────┐ ┌──▼──────────┐    │    ┌────────▼──────┐
    │ Researcher │ │Architect │ │TestDesigner │    │    │   Auditor      │
    │ crawls web │ │proposes  │ │writes test  │    │    │   reviews      │
    │ for best   │ │target    │ │plan from    │    │    │   creates PR   │
    │ practices  │ │architecture│architecture  │    │    │   or rejects   │
    └─────┬──────┘ └───┬──────┘ └──┬──────────┘    │    └────────┬──────┘
          │             │            │              │             │
          ▼             ▼            ▼              │             ▼
    GitHub Comment GitHub Comment GitHub Comment    │    GitHub Comment
    ## Research   ## Architecture ## Test Plan       │    ## Audit
          │             │            │              │             │
          └─────────────┴────────────┴──────────────┘             │
                                                          ┌──────▼──────┐
                                                          │ QUALITY GATES│
                                                          │ TSC + LSP    │
                                                          │ pass/fail    │
                                                          └──────┬──────┘
                                                                 │
                                                          ┌──────▼──────┐
                                                          │ Post-pipeline│
                                                          │ PR check &   │
                                                          │ merge        │
                                                          └─────────────┘
```

### Project board setup

Create a GitHub Project (v2) with these statuses:

```
Todo → Research → Architecture → TestDesign → Implementation → Audit → Done
```

Configure the project number in `.pi/settings.json`:

```json
{
  "supervisor": {
    "projectNumber": 3,
    "statusMapping": {
      "Research": "researcher",
      "Architecture": "architect",
      "TestDesign": "test-designer",
      "Implementation": "developer",
      "Audit": "auditor"
    }
  }
}
```

Use **Board** layout in GitHub, set **Group by** to `Workflow`.

### Quality gates

Before transitioning Implementation → Audit, the supervisor runs:

1. **TSC Checkpoint** — `npx tsc --noEmit` on the worktree
2. **LSP Pre-Audit** — Real LSP diagnostics on modified files only

If either fails, the issue goes back to Implementation (max 3 retries for LSP). Quality gate failures do NOT count as Auditor rejections.

### Loop rules

- Auditor can reject → sends back to Implementation (counts as 1 rejection)
- `maxRejections` (default 5) stops the loop to prevent infinite cycles
- `agentTokenBudget` sets a soft cap on total tokens per agent (0 = unlimited)
- `maxToolCalls` sets a hard cap on tool invocations per agent (0 = unlimited)

### Agent deep dive

| # | Agent | Thinking | Entry Marker | Output Format |
|---|-------|----------|-------------|---------------|
| 1 | **Researcher** | medium | `Research` | JSON + GitHub comment |
| 2 | **Architect** | high | `Architecture` | JSON + GitHub comment |
| 3 | **TestDesigner** | medium | `TestDesign` | JSON + GitHub comment |
| 4 | **Developer** | low | `Implementation` | JSON + Git commit + push |
| 5 | **Auditor** | medium | `Audit` | JSON with APPROVED/REJECTED |

### Complete walkthrough

When you run `/supervisor 42`:

1. **Fetch** — Supervisor reads settings, fetches issue #42 from GitHub, filters to trusted codeowners
2. **Researcher** — Crawls 3-5 web pages, posts `## Research Findings` comment, moves board to Architecture
3. **Architect** — Analyzes codebase, proposes architecture following Clean Architecture + PEAA, posts `## Architecture Approach`
4. **TestDesigner** — Writes test plan, posts `## Test Plan`
5. **Developer** — Supervisor creates git worktree, Developer implements feature, commits, pushes
6. **Quality Gates** — TSC + LSP checks pass, moves to Audit
7. **Auditor** — Reviews diff, approves or rejects, creates PR if approved, posts `## Audit`
8. **Post-pipeline** — Checks PR for merge conflicts, asks user to auto-fix if needed

## Session logging

The session logger produces these outputs:

| Format | File | Description |
|--------|------|-------------|
| JSONL | `.pi/sessions/<datetime>_<uuid>.jsonl` | Event stream per session |
| Markdown | `.pi/sessions/<sessionId>.md` | Human-readable session summary |
| Metadata | `.pi/sessions/<sessionId>.metadata.json` | Structured session metadata |
| Advice | `.pi/sessions/<sessionId>.advice.md` | Improvement recommendations |
| Latest symlinks | `.pi/sessions/latest.*` | Convenience symlinks |

Reports include sub-agent output from supervisor pipeline agents (developer, auditor, researcher, test-designer) with agent header, status, tool count, token count, duration, and audit score.

### Session advice patterns

| Pattern | Severity | Example |
|---------|----------|--------|
| Tool mismatch | error | `bash | grep` instead of `ripgrep_search` |
| Error not actioned | error | Tool errors, retries same tool 4x |
| Identical call loop | error | Same tool+args 3x in last 12 calls |
| Same-tool cascade | warning | `bash` called 12x consecutively |
| Tool coverage gap | warning | Code files present but `structural_search` unused |
| Structural-search underuse | warning | 3+ code files read, `structural_search` never called |
| Redundant reads | warning | Same file read within 2 turns |
| Excessive turns | warning | 20+ tool calls with no file changes |

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

### Tool benchmark

Empirical token consumption comparing tool configurations on a real audit task. 5 runs per config.

| Config | Avg In | Avg Out | Avg Total | Avg Cost | Avg Duration |
|--------|--------|---------|-----------|----------|-------------|
| 1 — no tools | 1,351 | 1,272 | 2,623 | $0.00055 | 13.5s |
| 2 — structural-only | 15,231 | 5,075 | 178,438 | $0.00400 | 62.3s |
| 3 — structural + ripgrep | 13,769 | 5,850 | 177,700 | $0.00401 | 67.6s |

**Key takeaways:**
- No-tools is cheap but agent can't do the task — thin/empty results
- Structural-analyzer massively improves quality at ~$0.004/run
- Adding ripgrep doesn't significantly change cost vs structural-only for this task

## Daily workflow

### Project setup (one-time)

Create a GitHub Project (v2) with Kanban statuses matching `supervisor.statusMapping` in `.pi/settings.json`. Configure the project number under `supervisor.projectNumber`. Use **Board** layout with **Group by** set to `Workflow`.

### Typical session

1. Start with `pi`
2. Select or create a GitHub issue
3. Run `/supervisor <issue-number>` to start the pipeline
4. Monitor progress via TUI status bar
5. Review results when pipeline completes

### Context & templates

| Type | File | Behavior |
|------|------|----------|
| **Always-on** | `AGENTS.md` in project root | Appended to system prompt every turn |
| **On-demand** | `.pi/prompts/*.md` | Invoked via `/prompt-name` in Pi's editor |

`AGENTS.md` contains the caveman protocol (communication style + tool routing) and **Tool Discipline** section (pre-call checklist, DO/DON'T table, error recovery procedure, batching triggers).

### Configuration reference

```jsonc
// .pi/settings.json — supervisor section
{
  "supervisor": {
    "repo": "SchneiderDaniel/cheasee-pi",  // REQUIRED
    "projectNumber": 3,                      // REQUIRED
    "statusMapping": { /* board status → agent */ },
    "codeowners": ["SchneiderDaniel"],       // REQUIRED
    "statusField": "Status",
    "maxRejections": 3,
    "agentTokenBudget": 300000,
    "bellOnComplete": false
  }
}
```

## Security

- No MCP servers — only pi extensions (no network-exposed tool servers)
- API keys loaded from `.agent_env`, never committed
- `.piignore` path blocking
- **npm package age gate** — refuses to install packages < 14 days old
- **Scope boundary enforcement** — pre-dispatch git diff check restricts agent file writes by issue label
