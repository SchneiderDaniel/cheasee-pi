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

**Location:** `.pi/extensions/supervisor/`
