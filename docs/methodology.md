---
layout: default
title: Methodology
nav_order: 3
---

# Methodology

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Kanban-driven pipeline

The pipeline runs 5 agents in sequence:

```
Researcher → Architect → TestDesigner → Developer → Auditor
```

Each agent produces output and the pipeline moves to the next stage.

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

See [Extensions → Supervisor](extensions/supervisor) for agent definitions and tools.

## Daily workflow

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
