---
layout: default
title: Session Logger
parent: Extensions
nav_order: 9
---

# Session Logger

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/session-logger/README.md)

**Why.** Generates rich Markdown reports alongside pi's `.jsonl` session files — per-turn token breakdown, tool execution stats, file modifications, sub-agent output, and error summaries.

**How it works.** Hooks into session lifecycle (`session_start`, `session_shutdown`), turn events (`turn_start`, `turn_end`), message events (`message_end`), tool events (`tool_execution_start`, `tool_execution_end`, `tool_call`). Tracks: token in/out per turn, thinking tokens, tool execution duration, file modifications (write/edit). On shutdown, writes `.md` report and `.metadata.json` alongside the `.jsonl` file. Toggle with `/session-logger`. Trust-gated — only generates reports on trusted projects. Latest symlinks for easy access.

### Output formats

| Format | File | Description |
|--------|------|-------------|
| JSONL | `.pi/sessions/<datetime>_<uuid>.jsonl` | Event stream per session |
| Markdown | `.pi/sessions/<sessionId>.md` | Human-readable session summary |
| Metadata | `.pi/sessions/<sessionId>.metadata.json` | Structured session metadata |
| Advice | `.pi/sessions/<sessionId>.advice.md` | Improvement recommendations |
| Latest symlinks | `.pi/sessions/latest.*` | Convenience symlinks |

Reports include sub-agent output from supervisor pipeline agents (developer, auditor, researcher, test-designer) with agent header, status, tool count, token count, duration, and audit score.

**Location:** `.pi/extensions/session-logger/`
