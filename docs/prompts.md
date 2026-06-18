---
layout: default
title: Prompts
nav_order: 9
---

# Prompts

{: .no_toc }

Prompt templates are invocable via `/name` in Pi's editor. Files stored in `.pi/prompts/` organized by category.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

| Template | Usage | What it does |
|----------|-------|--------------|
| **issue-cutter** | `/issue-cutter <number>` | Split epic into ordered, testable sub-issues with layer labels. Auto-links children to parent via GraphQL. |
| **issue-refinement** | `/issue-refinement <number>` | Grill issue against codebase, Socratic interview via `ask_user` (≥3 MC options), replace body with concrete ACs. |
| **handover** | `/handover` | Write handover doc summarizing conversation. Saves to `tmp/` with datetime prefix. |
| **pr-review** | `/pr-review` | Automated PR security/quality checks, validates against Cheasee-Pi philosophy, formats structured review comment. |
| **quiz-master** | `/quiz-master` | List open PRs across repo + submodules, quiz reviewer on diff with MC questions, auto-merge if score ≥80%. |
| **model-select** | `/model-select <objective>` | Research + recommend models per agent role. Crawls providers, benchmarks, pricing. Three objectives: cost-optimized, performance-optimized, balanced. |
| **package-extension** | `/package-extension` | Package selected extension from monorepo as individual npm pi-package. Sets up package.json with pi manifest, guides through publishing. |
| **architecture-review** | `/architecture-review` | Audit codebase architecture against Clean Architecture + PEAA principles. Identifies violations, proposes refactors. |
| **changelog-check** | `/changelog-check` | Analyze pi CHANGELOG.md for breaking changes affecting extensions. Generates migration report. |
| **extension-validation** | `/extension-validation <path>` | Validate extension structure, imports, hooks against pi extension API. |
| **writing-voice** | `/writing-voice` | Derive consistent AI writing voice from sample text (paste, URL, or file). Generates `voice-{lang}.md` style guide. |

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
