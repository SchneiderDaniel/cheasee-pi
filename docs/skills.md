---
layout: default
title: Skills
nav_order: 5
---

# Skills

{: .no_toc }

Skills are reusable Markdown instruction sets for specialized tasks. They are loaded on-demand via `/skill:<name>` invocation.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

Skills differ from extensions in that they are **prompt-based instruction sets** rather than executable tools. Each skill provides specialized knowledge and workflow instructions for a specific task.

**Note:** Model-invocable skill descriptions add context overhead on each turn. Prefer extensions (concise prompt snippets) or prompt templates (lazy-loaded) over skills.

## Available skills

### audit-architecture-review

Audit codebase architecture for shallow modules, leaky seams, low locality. Files umbrella issue with Mermaid diagrams + sub-issues per candidate.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:audit-architecture-review <target>`
- **Skills:** Structural search, import graph analysis, seam detection
- **Output:** GitHub umbrella issue with 2-5 candidates + sub-issues
- **Invocation:** `/skill:audit-architecture-review <target>`

### audit-clean-code

Scan code for oversized files/functions and "what" comments. Files umbrella + sub-issues with cited sources.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:audit-clean-code <target>`
- **Skills:** Size analysis, comment classification, evidence-based reporting
- **Rules:** SonarQube S104, Clean Code ch. 4
- **Invocation:** `/skill:audit-clean-code <target>`

### audit-code-simplification

Find deep nesting, dead code, unnecessary abstractions, naming issues. Files umbrella + sub-issues.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:audit-code-simplification <target>`
- **Skills:** Complexity analysis, dead code detection, naming audit
- **Patterns:** 5 simplification principles
- **Invocation:** `/skill:audit-code-simplification <target>`

### handover

Write a handover document summarizing the current conversation so a fresh agent can continue. Saves to `ignore/` with datetime prefix.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:handover`
- **Skills:** Conversation summarization, structured handoffs
- **Invocation:** `/skill:handover`

### git-issue-cutter

Split a GitHub epic into ordered, independently testable sub-issues and create them as children via GraphQL.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:git-issue-cutter <number>`
- **Skills:** Issue decomposition, vertical slicing, GraphQL API
- **Requires:** `gh` CLI, `supervisor.repo` in settings
- **Invocation:** `/skill:git-issue-cutter <number>`

### git-issue-refinement

Socratic interview via `ask_user` — one question at a time — to sharpen vague requirements into concrete acceptance criteria.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:git-issue-refinement <number>`
- **Skills:** Requirements analysis, codebase validation, Socratic questioning
- **Requires:** `gh` CLI, `ask_user` extension
- **Invocation:** `/skill:git-issue-refinement <number>`

### model-select

Research and recommend coding models per agent role (architect, developer, test-designer, auditor, researcher) based on benchmarks, pricing, and platform restrictions.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:model-select`
- **Skills:** Web crawling, benchmark analysis, cost modeling
- **Output:** Per-agent recommendation table with cost projections
- **Invocation:** `/skill:model-select`

### git-pr-quiz-master

Quiz reviewer on PR diff with 3-5 multiple-choice questions. Auto-merges if score ≥ 80%.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:git-pr-quiz-master`
- **Skills:** Diff comprehension testing, PR review automation
- **Requires:** `gh` CLI, `ask_user` extension
- **Invocation:** `/skill:git-pr-quiz-master`

### voice-trainer

Collect writing samples from user (paste, URL, or file), analyze 7 style dimensions, generate `voice-{lang}.md` style guide.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:voice-trainer`
- **Skills:** Style analysis, pattern abstraction, guide generation
- **Output:** New voice file in `.pi/skills/writing-voice/references/`
- **Invocation:** `/skill:voice-trainer`

### git-issue-create-external

File high-quality issues on external public GitHub repositories. Enforces a strict 5-step checklist: read repo guidelines, read issue templates, check for duplicates, write professional issue body with neutral reproducible examples, and file via `gh issue create`.

- **Mode:** Auto — agent may invoke without explicit user command
- **Skills:** Duplicate detection, issue template compliance, professional writing
- **Scope:** External public repos only
- **Dependency:** `gh` CLI authenticated

### git-issue-create-internal

Create an issue on the repository configured in `.pi/settings.json`, using the internal issue template and project-board workflow.

- **Mode:** Auto — agent may invoke without explicit user command
- **Scope:** Cheasee-Pi's configured internal repository
- **Dependency:** Authenticated `gh` CLI and repository settings

### codeflow-analysis

Interpret a CodeFlow analysis report, group findings by file, and propose internal GitHub issues after explicit confirmation. The skill owns the whole capability, including the report fetch: `scripts/fetch-report.mts` fetches the browser-run analysis from the local CodeFlow shim and writes `ignore/codeflow-report.md` and `ignore/codeflow-report.json`.

```bash
node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/fetch-report.mts [--refresh]
```

It prints `{path, jsonPath, bytes, analyzedAt, warnings}`. Exit `0` on success, `2` when no analysis has run yet (HTTP 404 — run an analysis in the CodeFlow UI and retry), `1` on a transport or write failure. Both artifacts are written through an exclusive temp file and atomic rename with mode `0600`, and a report directory that resolves outside the workspace through a symlink is refused. The markdown export omits duplicate-code findings, layer violations, and suggestions; the JSON export carries them and is the preferred source.

- **Mode:** Auto — agent may invoke without explicit user command
- **Dependency:** CodeFlow report artifacts and configured internal repository

### git-pr-resolve-conflict

Resolve conflicts on pull-request branches in Git worktrees while preserving combined behavior and validating the merged result.

- **Mode:** Auto — agent may invoke when a worktree branch must absorb upstream changes

### skill-creator

Create or update Pi skills using the repository's skill-writing standards.

- **Mode:** Auto — agent may invoke when a skill is being created or updated

### writing-great-skills

Apply structured guidance for designing clear, reliable, maintainable skills.

- **Mode:** Auto — agent may invoke when skill design or revision is requested

### ponytail (lazy senior dev mode)

Lazy senior developer mode — YAGNI, stdlib-first, minimal code. Active automatically via the ponytail extension's `before_agent_start` hook. Ships 6 related skills, of which cheasee-pi registers only the core one by default (the package's `packages` entry in `.pi/settings.json` carries a `skills: ["!ponytail-*"]` filter — see [Ponytail](extensions/ponytail.md)):

| Skill | Trigger | Purpose |
|-------|---------|--------|
| ponytail | `/skill:ponytail` | Lazy mode rules (base skill) — installed by default |
| ponytail-review | `/skill:ponytail-review` | Diff-level over-engineering review: yagni, stdlib, native, shrink tags |
| ponytail-audit | `/skill:ponytail-audit` | Whole-repo bloat scan (same tags, repo-wide) |
| ponytail-debt | `/skill:ponytail-debt` | Harvest deliberate shortcuts (`ponytail:` comments) into debt ledger |
| ponytail-gain | `/skill:ponytail-gain` | Measured-impact scoreboard: less code, less cost, more speed |
| ponytail-help | `/skill:ponytail-help` | Quick-reference card for all ponytail modes and skills |

**Source:** [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) — external package; only the core `ponytail` skill is linked into `.pi/skills/ponytail/`.

**Mode:** Auto — `ponytail` is agent-invocable (description injected every turn); the five auxiliary skills need `pi config --local` to register.

### writing-voice

Apply the repository's stored writing voice before drafting user-facing prose. The skill reads language-specific rules and does not modify them.

- **Mode:** Manual — agent cannot auto-invoke; use `/skill:writing-voice`
- **Skills:** Voice analysis, style guide generation
- **Input:** Sample text (URL, file path, or paste)
- **Output:** Structured voice style guide

## Usage

Invoke a skill during a session:

```
/skill:ponytail-review "Review this diff for over-engineering"
```

Or use the dedicated command if available:

```
/ponytail-review
```

## Creating skills

Skills are Markdown files in `.pi/skills/<name>/SKILL.md` with YAML frontmatter. They can reference tools, reference files, and define structured workflows.

**Control autoloading:** Add `disable-model-invocation: true` to frontmatter to hide the skill from the agent. It will only be invocable manually via `/skill:name`. Use this for complex workflow skills that should not clutter the system prompt.
