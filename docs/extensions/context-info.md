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

**How it works.** Creates `FooterState` on session start, reads config from `.pi/settings.json` (`contextInfo` section). Detects git worktree name, captures session name and trust status. Installs custom footer via `ctx.ui.setFooter()` (TUI only). Updates reactively on `model_select`, `thinking_level_select`, `turn_end`, `message_end` (token+cache stats), `message_update` (TPS sampling), `tool_execution_end`. Timer updates session duration display every second. Session_shutdown stops timer. Also registers `/explain-extensions`, `/explain-prompts`, `/explain-skills` commands.

**Location:** `.pi/extensions/context-info/`
