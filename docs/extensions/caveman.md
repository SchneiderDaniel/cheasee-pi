---
layout: default
title: Caveman Protocol
parent: Extensions
nav_order: 15
---

# Caveman Protocol

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/caveman/README.md)

**Why.** Reduces response token count 30-50% by dropping articles, filler words, pleasantries, and hedging from all agent output. Active every session via `AGENTS.md`. Saves thousands of tokens per session.

**How it works.** Reads config from `~/.pi/agent/caveman.json`, checks `AGENTS.md` for session level override. Three intensity levels: **lite** (professional, tight sentences, drops filler only), **full** (fragments, drops articles, short synonyms), **off** (no compression). Mode-adaptive — skips compression in JSON/RPC modes to avoid mangling structured output. Auto-lightens when `ripgrep_search`/`structural_search` are active (preserves tool output structure). Injects rules into system prompt via `before_agent_start`. Cycle with `/caveman` command. Auto-clarity: full caveman disables for security warnings, irreversible actions, or when user asks to clarify.

**Location:** `.pi/extensions/caveman/`
