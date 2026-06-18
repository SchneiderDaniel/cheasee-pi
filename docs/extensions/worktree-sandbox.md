---
layout: default
title: Worktree Sandbox
parent: Extensions
nav_order: 7
---

# Worktree Sandbox

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/worktree-sandbox/README.md)

**Why.** Enforces agents operate ONLY within their assigned git worktree — deterministic enforcement at the tool call boundary, not prompt-level. Blocks `cd` escape via variables, tilde expansion, command substitution, pipe prefix bypasses, and shell redirects outside worktree.

**How it works.** Activated by setting `WORKTREE_SANDBOX_PATH` env var. Hooks `tool_call`: `read`/`write`/`edit` rewrite relative paths to worktree root, block absolute paths outside. `bash` prepends `cd "<worktree>" && ` to every command. Shell-aware parsing via `shell-quote` detects escape vectors: variable expansion (`$HOME`) → `<HOME>`, tilde expansion (`~`) → `hasShellExpansion()`, pipe prefix (`echo | cd /escape`) → `isCommandStart()`. Also blocks file writes via redirect (`>`, `>>`), `cp`/`mv`/`touch` destinations outside worktree. Trust gate checks `ctx.isProjectTrusted()` before resolving sandbox root — prevents attacker-controlled env var from redirecting sandbox.

**Location:** `.pi/extensions/worktree-sandbox/`
