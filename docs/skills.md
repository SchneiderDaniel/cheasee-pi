---
layout: default
title: Skills
nav_order: 7
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

### dead-code-hunter

Systematic dead code detection for pi extensions. Picks random extension, analyzes for unused exports, unreachable paths, dead branches, orphaned utilities, and other dead code patterns. Validates with deterministic proof and creates GitHub issues.

- **Skills:** Export analysis, reachability analysis, branch coverage, orphan detection
- **Output:** GitHub issue with `dead-code-<ext>-<date>` label

### extension-bug-hunter

Systematic bug hunting for pi extensions. Analyzes code using best-practice bug hunting techniques — boundary analysis, type safety, error paths, concurrency, input validation, security. Validates findings with reproducible proof.

- **Skills:** Boundary analysis, type safety audit, error path tracing, concurrency review, input validation, security review
- **Search strategy:** Three-strike proof

### extension-spec

Designs pi extensions — new or refactoring — with full PRD, TypeScript best practices, anti-pattern audit, and migration plan.

- **Skills:** PRD generation, TypeScript audit, migration planning
- **Use cases:** Creating new extensions, refactoring existing ones

### duplicate-code-hunter

Systematic duplicate code detection for pi extensions. Analyzes for exact clones (Type 1), renamed clones (Type 2), near-miss (Type 3), and semantic clones (Type 4). Uses jscpd for token-based scanning.

- **Skills:** Clone type classification, jscpd integration, three-way-match proof
- **Output:** GitHub issue with clone evidence

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
