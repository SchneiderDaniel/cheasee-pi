---
layout: default
title: Skills
nav_order: 5
---

# Skills

{: .no_toc }

Skills are reusable instruction sets for specialized tasks. They are loaded on-demand via `/skill:<name>` invocation.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

Skills differ from extensions in that they are **prompt-based instruction sets** rather than executable tools. Each skill provides specialized knowledge and workflow instructions for a specific task.

**Note:** Every skill's description injects ~50-150 tokens into the context window on every turn. Use sparingly. Prefer extensions (concise prompt snippets) or prompt templates (lazy-loaded) over skills.

## Available skills

### architecture-review

Audit codebase architecture for shallow modules, leaky seams, low locality. Files umbrella issue with Mermaid diagrams + sub-issues per candidate.

- **Skills:** Structural search, import graph analysis, seam detection
- **Output:** GitHub umbrella issue with 2-5 candidates + sub-issues
- **Invocation:** `/skill:architecture-review <target>`

### clean-code-audit

Scan code for oversized files/functions and "what" comments. Files umbrella + sub-issues with cited sources.

- **Skills:** Size analysis, comment classification, evidence-based reporting
- **Rules:** SonarQube S104, Clean Code ch. 4
- **Invocation:** `/skill:clean-code-audit <target>`

### code-simplification

Find deep nesting, dead code, unnecessary abstractions, naming issues. Files umbrella + sub-issues.

- **Skills:** Complexity analysis, dead code detection, naming audit
- **Patterns:** 5 simplification principles
- **Invocation:** `/skill:code-simplification <target>`

### handover

Write a handover document summarizing the current conversation so a fresh agent can continue. Saves to `ignore/` with datetime prefix.

- **Skills:** Conversation summarization, structured handoffs
- **Invocation:** `/skill:handover`

### issue-cutter

Split a GitHub epic into ordered, independently testable sub-issues and create them as children via GraphQL.

- **Skills:** Issue decomposition, vertical slicing, GraphQL API
- **Requires:** `gh` CLI, `supervisor.repo` in settings
- **Invocation:** `/skill:issue-cutter <number>`

### issue-refinement

Socratic interview via `ask_user` — one question at a time — to sharpen vague requirements into concrete acceptance criteria.

- **Skills:** Requirements analysis, codebase validation, Socratic questioning
- **Requires:** `gh` CLI, `ask_user` extension
- **Invocation:** `/skill:issue-refinement <number>`

### model-select

Research and recommend coding models per agent role (architect, developer, test-designer, auditor, researcher) based on benchmarks, pricing, and platform restrictions.

- **Skills:** Web crawling, benchmark analysis, cost modeling
- **Output:** Per-agent recommendation table with cost projections
- **Invocation:** `/skill:model-select`

### pr-review

Review external contributor PRs with 12 automated checks (secrets scan, dependency audit, philosophy alignment, pi docs compliance) plus human checklist.

- **Skills:** Security scanning, linting, dependency analysis
- **Output:** Formatted review comment
- **Invocation:** `/skill:pr-review <number>`

### quiz-master

Quiz reviewer on PR diff with 3-5 multiple-choice questions. Auto-merges if score ≥ 80%.

- **Skills:** Diff comprehension testing, PR review automation
- **Requires:** `gh` CLI, `ask_user` extension
- **Invocation:** `/skill:quiz-master`

### voice-trainer

Collect writing samples from user (paste, URL, or file), analyze 7 style dimensions, generate `voice-{lang}.md` style guide.

- **Skills:** Style analysis, pattern abstraction, guide generation
- **Output:** New voice file in `.pi/skills/writing-voice/references/`
- **Invocation:** `/skill:voice-trainer`

### external-issue

File high-quality issues on external public GitHub repos. Enforces a strict 5-step checklist: read repo guidelines, read issue templates, check for duplicates, write professional issue body with neutral reproducible examples, and file via `gh issue create`.

- **Skills:** Duplicate detection, issue template compliance, professional writing
- **Scope:** External public repos only
- **Dependency:** `gh` CLI authenticated

### ponytail (lazy senior dev mode)

Lazy senior developer mode — YAGNI, stdlib-first, minimal code. Active automatically via the ponytail extension's `before_agent_start` hook. Ships 6 related skills:

| Skill | Trigger | Purpose |
|-------|---------|--------|
| ponytail | `/skill:ponytail` | Lazy mode rules (base skill) |
| ponytail-review | `/skill:ponytail-review` | Diff-level over-engineering review: yagni, stdlib, native, shrink tags |
| ponytail-audit | `/skill:ponytail-audit` | Whole-repo bloat scan (same tags, repo-wide) |
| ponytail-debt | `/skill:ponytail-debt` | Harvest deliberate shortcuts (`ponytail:` comments) into debt ledger |
| ponytail-gain | `/skill:ponytail-gain` | Measured-impact scoreboard: less code, less cost, more speed |
| ponytail-help | `/skill:ponytail-help` | Quick-reference card for all ponytail modes and skills |

**Source:** [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) — external package symlinked into `.pi/skills/ponytail/`.

### writing-voice

Derive consistent AI writing voice from sample text (paste, URL, or file). Generates `voice-{lang}.md` style guide. Applied before drafting any user-facing prose.

- **Skills:** Voice analysis, style guide generation
- **Input:** Sample text (URL, file path, or paste)
- **Output:** Structured voice style guide

## Usage

Invoke a skill during a session:

```
/skill:extension-spec "Create a tool that validates YAML files"
```

Or use the dedicated command if available:

```
/extension-spec <idea>
```

## Creating skills

Skills are Markdown files in `.pi/skills/<name>/SKILL.md` with YAML frontmatter. They can reference tools, reference files, and define structured workflows.

**Control autoloading:** Add `disable-model-invocation: true` to frontmatter to hide the skill from the agent. It will only be invocable manually via `/skill:name`. Use this for complex workflow skills that should not clutter the system prompt.

> **Note:** Harness-dev skills (`extension-bug-hunter`, `extension-dead-code-hunter`, `extension-duplicate-code-hunter`, `extension-reinvention-issue-hunter`, `extension-spec`, `rebuild-cheasee-pi`, `release-cheasee-pi`, `supervisor-render`) are internal — not included in the public build. Customer skills with `disable-model-invocation: true` (`architecture-review`, `clean-code-audit`, `code-simplification`, `handover`, `issue-cutter`, `issue-refinement`, `model-select`, `pr-review`, `quiz-master`, `voice-trainer`) are visible in docs but hidden from the agent.
