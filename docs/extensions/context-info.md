---
layout: default
title: Context Info
parent: Extensions
nav_order: 8
---

# Context Info

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/context-info/README.md)

**Why.** Replaces pi's default footer with a rich dashboard: git branch, model name, token usage with color thresholds, TPS during streaming, cache hit rate, session name, trust status, thinking level, live timer, and tool call counter.

**How it works.** Creates `FooterState` on session start, reads config from `.pi/settings.json` (top-level settings: `quietStartup`, `contextStatusBar.showTps`). Detects git worktree name, captures session name and trust status. Installs custom footer via `ctx.ui.setFooter()` (TUI only). Updates reactively on `model_select`, `thinking_level_select`, `turn_end`, `message_end` (token+cache stats), `message_update` (TPS sampling through deduplicated key extraction), `tool_execution_end`. Timer updates session duration display every second. Session_shutdown stops timer.

Registers three `/explain-*` commands for listing discovery:
- `/explain-extensions` — Lists all active extensions with descriptions
- `/explain-prompts` — Lists all available prompt templates
- `/explain-skills` — Lists all available skills

Also provides `setSupervisorIssueData` / `clearSupervisorIssueData` exported API for the supervisor pipeline to display current issue number/title/repo in the TUI footer.

**Location:** `.pi/extensions/context-info/`
