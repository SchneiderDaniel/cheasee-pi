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

### Tool benchmark

Empirical token consumption comparing tool configurations on a real audit task. 5 runs per config.

| Config | Avg In | Avg Out | Avg Total | Avg Cost | Avg Duration |
|--------|--------|---------|-----------|----------|-------------|
| 1 — no tools | 1,351 | 1,272 | 2,623 | $0.00055 | 13.5s |
| 2 — structural-only | 15,231 | 5,075 | 178,438 | $0.00400 | 62.3s |
| 3 — structural + ripgrep | 13,769 | 5,850 | 177,700 | $0.00401 | 67.6s |

**Key takeaways:**
- No-tools is cheap but agent can't do the task — thin/empty results
- Structural-analyzer massively improves quality at ~$0.004/run
- Adding ripgrep doesn't significantly change cost vs structural-only for this task

**Location:** `.pi/extensions/structural-analyzer/`
