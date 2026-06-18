---
layout: default
title: Supervisor
parent: Extensions
nav_order: 5
---

# Supervisor

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/supervisor/README.md)

**Why.** Autonomous Kanban pipeline driving 5 agents (Researcher → Architect → TestDesigner → Developer → Auditor) through GitHub Project board status transitions. Creates worktrees, manages quality gates, creates PRs. Full development lifecycle automation.

**How it works.** Triggered via `/supervisor <issue-number>`. Reads config from `.pi/settings.json` (repo, project number, status mapping, codeowners). Fetches GitHub issue, creates worktree at `.worktrees/feature-N/`. Dispatches agents per board status — each agent reads its definition from `.pi/extensions/supervisor/agents/<agent>.md` (YAML frontmatter defining tools, skills, model). Posts results as GitHub comments, moves board cards. Quality gates: `tsc --noEmit` + LSP diagnostics between Implementation and Audit. Auditor approves/rejects; rejected issues cycle back to Implementation (max `maxRejections` default 5). Creates PR on approval. Supports submodules with matched-branch pattern. Token budgets and tool call limits per agent.

### Agent definitions

| Agent | Tools | Skills | Thinking | Entry Marker | Output Format |
|-------|------|--------|----------|-------------|---------------|
| **Researcher** | read, bash, structural_search, ripgrep_search | — | medium | `Research` | JSON + GitHub comment |
| **Architect** | read, bash, structural_search, ripgrep_search | `extension-spec` | high | `Architecture` | JSON + GitHub comment |
| **TestDesigner** | read, bash, structural_search, ripgrep_search | — | medium | `TestDesign` | JSON + GitHub comment |
| **Developer** | read, bash, write, edit, structural_search, ripgrep_search | `extension-spec` | low | `Implementation` | JSON + Git commit + push |
| **Auditor** | read, bash, structural_search, ripgrep_search | `duplicate-code-hunter` | medium | `Audit` | JSON with APPROVED/REJECTED |

All agents use `opencode-go/deepseek-v4-flash` model. Developer additionally uses format-on-save and tsc-checkpoint.

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

**Location:** `.pi/extensions/supervisor/`
