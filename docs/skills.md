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

<!-- extension-dead-code-hunter, extension-bug-hunter, extension-spec, extension-duplicate-code-hunter, extension-reinvention-issue-hunter are internal harness-dev skills -->

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

> **Note:** Harness-dev skills (`extension-bug-hunter`, `extension-dead-code-hunter`, `extension-duplicate-code-hunter`, `extension-reinvention-issue-hunter`, `extension-spec`, `rebuild-cheasee-pi`, `release-cheasee-pi`) are internal — not included in the public build.
