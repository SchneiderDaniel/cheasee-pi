---
layout: default
title: Prompts
nav_order: 7
---

# Prompts

{: .no_toc }

Prompt templates are invocable via `/name` in Pi's editor. Files stored in `.pi/prompts/` organized by category.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Requirement prompts

### issue-cutter

Split an epic into ordered, testable sub-issues with layer labels. Auto-links children to parent via GraphQL.

```
/issue-cutter <number>
```

**Input:** GitHub issue number of the epic
**Output:** Multiple sub-issues with layer labels, linked to parent

### issue-refinement

Grill an issue against the codebase via Socratic interview. Uses `ask_user` with ≥3 MC options. Replaces body with concrete acceptance criteria.

```
/issue-refinement <number>
```

**Input:** GitHub issue number
**Output:** Refined issue with concrete ACs

## Development prompts

### handover

Write a handover document summarizing the conversation. Saves to `tmp/` with datetime prefix.

```
/handover
```

**Output:** Markdown file in `tmp/handover-<datetime>.md`

### pr-review

Automated PR security/quality checks. Validates against Cheasee-Pi philosophy. Formats structured review comment.

```
/pr-review
```

### quiz-master

List open PRs across repo and submodules, quiz reviewer on diff with MC questions, auto-merge if score ≥80%.

```
/quiz-master
```

## Operations prompts

### model-select

Research and recommend models per agent role. Crawls providers, benchmarks, pricing. Three objectives:

| Objective | Focus |
|-----------|-------|
| `cost-optimized` | Lowest cost per token |
| `performance-optimized` | Best quality/output |
| `balanced` | Best trade-off |

```
/model-select <objective>
```

### package-extension

Package a selected extension from the monorepo as an individual npm pi-package. Sets up `package.json` with pi manifest, guides through publishing.

```
/package-extension
```

### architecture-review

Audit codebase architecture against Clean Architecture + PEAA principles. Identifies violations, proposes refactors.

```
/architecture-review
```

### changelog-check

Analyze pi CHANGELOG.md for breaking changes affecting extensions. Generates migration report.

```
/changelog-check
```

### extension-validation

Validate extension structure, imports, hooks against the pi extension API.

```
/extension-validation <path>
```

## Misc prompts

### writing-voice

Derive consistent AI writing voice from sample text (paste, URL, or file). Generates `voice-{lang}.md` style guide.

```
/writing-voice
```

**Input:** Sample text (paste, URL, or file path)
**Output:** Structured voice style guide

## Template organization

```
.pi/prompts/
├── requirement/
│   ├── issue-cutter.md
│   └── issue-refinement.md
├── development/
│   ├── handover.md
│   ├── pr-review.md
│   └── quiz-master.md
├── operations/
│   ├── model-select.md
│   ├── package-extension.md
│   ├── architecture-review.md
│   ├── changelog-check.md
│   └── extension-validation.md
└── misc/
    └── writing-voice.md
```
