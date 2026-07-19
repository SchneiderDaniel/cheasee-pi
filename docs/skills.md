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

### extension-dead-code-hunter

Systematic dead code detection for pi extensions. Picks random extension, analyzes for unused exports, unreachable paths, dead branches, orphaned utilities, and other dead code patterns. Validates with deterministic proof and creates GitHub issues.

- **Skills:** Export analysis, reachability analysis, branch coverage, orphan detection
- **Output:** GitHub issue with `<ext>` label

### extension-bug-hunter

Systematic bug hunting for pi extensions. Analyzes code using best-practice bug hunting techniques — boundary analysis, type safety, error paths, concurrency, input validation, security. Validates findings with reproducible proof.

- **Skills:** Boundary analysis, type safety audit, error path tracing, concurrency review, input validation, security review
- **Search strategy:** Three-strike proof

### extension-spec

Designs pi extensions — new or refactoring — with full PRD, TypeScript best practices, anti-pattern audit, and migration plan.

- **Skills:** PRD generation, TypeScript audit, migration planning
- **Use cases:** Creating new extensions, refactoring existing ones

### extension-duplicate-code-hunter

Systematic duplicate code detection for pi extensions. Analyzes for exact clones (Type 1), renamed clones (Type 2), near-miss (Type 3), and semantic clones (Type 4). Uses jscpd for token-based scanning.

- **Skills:** Clone type classification, jscpd integration, three-way-match proof
- **Output:** GitHub issue with clone evidence

### extension-reinvention-issue-hunter

Systematic detection of pi built-in API reimplementations in extensions. Picks random extension, cross-references custom code against live pi documentation, finds where extensions reinvent built-in features (dialogs, file-queue, truncation, state management, rendering, bash execution, etc.). Creates GitHub issues with migration steps and LOC reduction estimates.

- **Skills:** Live doc analysis, cross-reference, API catalog building
- **Detection:** Custom UI dialogs, file mutation queue, truncation utilities, state management, tool rendering, bash execution, keybinding handling
- **Output:** GitHub issue per confirmed finding with migration snippet

### external-issue

Guides the agent to autonomously file high-quality issues on external public GitHub repos. Enforces a strict 5-step checklist: read repo guidelines, read issue templates, check for duplicates, write professional issue body with neutral reproducible examples, and file via `gh issue create`.

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
