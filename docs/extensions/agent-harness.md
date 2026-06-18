---
layout: default
title: Agent Harness
parent: Extensions
nav_order: 13
---

# Agent Harness

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/agent-harness/README.md)

**Why.** Stops token waste before it executes. Every incorrect tool call costs tokens. Every error loop burns context window. Agent Harness intercepts tool calls and blocks wasteful patterns: `bash | grep` redirects to `ripgrep_search`, error retries blocked after 2 consecutive failures, same-tool cascades blocked after 8+ consecutive calls, redundant reads return cached results within 6 turns.

**How it works.** Hooks into pi's `tool_call` event and runs each call through a 7-step validation: pass-through check (ask_user etc.) → error tracking → cache invalidation on writes/edits → error retry guard (2+ errors) → read caching (6-turn TTL) → cascade detection (8+ consecutive) → tool mismatch blocks (bash|grep → ripgrep_search, bash cat → read). Configurable via `.pi/harness-config.json` with per-tool `cascadeThreshold` and `passThrough` flags. Caches reads across turns, re-read within TTL returns cached content without re-execution.

**Location:** `.pi/extensions/agent-harness/`
