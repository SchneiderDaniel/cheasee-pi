---
layout: default
title: Ask User
parent: Extensions
nav_order: 17
---

# Ask User

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/ask-user/README.md) — [`@cheasee-pi/ask-user` on npm](https://www.npmjs.com/package/@cheasee-pi/ask-user)

**Why.** The LLM needs decisions, preferences, or clarifications — instead of hallucinating defaults, it calls `ask_user` and you respond through a structured dialog. Supports multiple-choice (with recommendation marker) and free-text modes.

**How it works.** Two tools registered: `ask_user` (choice/freetext modes with mode-adaptive UI: TUI gets scrollable dialog, RPC gets flat option list, JSON/print gracefully cancel non-essential questions) and `ask_user_read` (retrieve past Q&A entries by id, list, or text search — returns `untrusted: true` when trust not granted). All interactions saved to `.pi/context/qna.jsonl` (legacy `.csv` auto-migrated). Trust-gated persistence — history only written when `ctx.isProjectTrusted()` is true. Includes `/qna` command for browsing history (gated behind project trust).

**Location:** `.pi/extensions/ask-user/`
