---
layout: default
title: Structural Analyzer
parent: Extensions
nav_order: 1
---

# Structural Analyzer

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/structural-analyzer/README.md) — [`@cheasee-pi/structural-analyzer` on npm](https://www.npmjs.com/package/@cheasee-pi/structural-analyzer)

**Why.** AST-aware code pattern search via ast-grep — finds function calls, class definitions, try/catch blocks, method invocations without noise from comments or strings. Prevents "find definitions by grep" anti-pattern.

**How it works.** Registers `structural_search` tool with S-expression and code-snippet pattern syntax (`$META_VAR` for single nodes, `$$$MULTI` for zero-or-more). Optional language parameter auto-detects from project config files (tsconfig.json → typescript, go.mod → go, etc.). Rejects single-word text patterns — redirects those to `ripgrep_search`. Results cached by (pattern, language, cwd). Streaming for >100 matches returns truncated summary with total count. TUI mode renders clickable `file://` hyperlinks.

**Location:** `.pi/extensions/structural-analyzer/`
