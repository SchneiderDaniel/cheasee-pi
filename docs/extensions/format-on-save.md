---
layout: default
title: Format on Save
parent: Extensions
nav_order: 11
---

# Format on Save

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/format-on-save/README.md)

**Why.** Auto-formats TS/JS files with Prettier and runs ESLint diagnostics after every `write` or `edit` — no manual step needed. Catches code quality issues early, before the supervisor Audit stage.

**How it works.** Hooks `tool_result` events for write/edit. Checks file existence, size (<5MB), and project trust. Runs Prettier formatter then ESLint linter asynchronously. TUI mode shows toast notifications via `ctx.ui.notify()`, RPC sends `followUp` messages via `pi.sendUserMessage()`, JSON/print stay silent. Non-blocking — errors don't crash the session. Trust gate prevents untrusted project configs from running arbitrary formatter commands.

**Location:** `.pi/extensions/format-on-save/`
