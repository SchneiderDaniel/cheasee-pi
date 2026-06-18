---
layout: default
title: Ripgrep Search
parent: Extensions
nav_order: 2
---

# Ripgrep Search

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/ripgrep-search/README.md) — [`@cheasee-pi/ripgrep-search` on npm](https://www.npmjs.com/package/@cheasee-pi/ripgrep-search)

**Why.** Fast literal/regex code search that respects `.gitignore`, returns structured summaries with match counts, file counts, and truncation info. Falls back to `grep` if ripgrep unavailable.

**How it works.** Registers `ripgrep_search` tool. Validates queries — rejects structural patterns (redirects to `structural_search`). Runs ripgrep with `--vimgrep` for structured output, or grep with `-rnH` as fallback. Results cached in memory by (query, directory). TUI mode renders clickable `file://` hyperlinks via OSC 8 escape sequences. Mode-adaptive output — non-TUI modes skip ANSI/OSC8 sequences. Result cache invalidated on session shutdown.

**Location:** `.pi/extensions/ripgrep-search/`
