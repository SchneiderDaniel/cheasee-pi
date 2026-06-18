---
layout: default
title: Methodology
nav_order: 3
---

# Methodology

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

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
