---
layout: default
title: Methodology
nav_order: 8
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
