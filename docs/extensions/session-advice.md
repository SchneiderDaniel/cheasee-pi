---
layout: default
title: Session Advice
parent: Extensions
nav_order: 10
---

# Session Advice

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/session-advice/README.md)

**Why.** After every session, analyzes JSONL log for wasteful patterns — tool mismatches, error loops, redundant reads, cascade cascades — and generates `.advice.md` with fix recommendations. Past lessons auto-injected into next session's system prompt.

**How it works.** On session shutdown, reads `.jsonl` and runs 10+ waste signal detectors: bash-grep (bash|grep), bash-cat (bash cat), error-loop (2+ errors), identical-args (same tool+args 3x), redundant-reads (same file within 2 turns), structural-underuse (code read without AST search), no-batch (consecutive same-tool), turn-inefficiency (20+ calls no changes). Generates `latest.advice.md` with severity labels. Next `before_agent_start`: reads advice, extracts top 3 actions, appends to system prompt. `/session-advice report` generates aggregate waste report with histogram and detector improvement suggestions.

### Detected patterns

| Pattern | Severity | Example |
|---------|----------|--------|
| Tool mismatch | error | `bash | grep` instead of `ripgrep_search` |
| Error not actioned | error | Tool errors, retries same tool 4x |
| Identical call loop | error | Same tool+args 3x in last 12 calls |
| Same-tool cascade | warning | `bash` called 12x consecutively |
| Tool coverage gap | warning | Code files present but `structural_search` unused |
| Structural-search underuse | warning | 3+ code files read, `structural_search` never called |
| Redundant reads | warning | Same file read within 2 turns |
| Excessive turns | warning | 20+ tool calls with no file changes |

**Location:** `.pi/extensions/session-advice/`
