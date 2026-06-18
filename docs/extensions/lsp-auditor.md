---
layout: default
title: LSP Auditor
parent: Extensions
nav_order: 6
---

# LSP Auditor

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/lsp-auditor/README.md) — [`@cheasee-pi/lsp-auditor` on npm](https://www.npmjs.com/package/@cheasee-pi/lsp-auditor)

**Why.** Runs real Language Server Protocol diagnostics on changed files before code review — catches errors, warnings, and hints the LLM might miss. Called automatically by the supervisor pipeline during the Audit stage.

**How it works.** Triggered manually via `/lsp-auditor` or automatically by supervisor (`runPreAudit()`). Uses `git diff <defaultBranch> --name-only` to find changed files. Groups by file extension (`.ts` → `typescript-language-server`, `.py` → `pylsp`, `.rs` → `rust-analyzer`, `.go` → `gopls`). Spawns LSP servers per group, opens files via `didOpen`, collects `publishDiagnostics` notifications. Filters by per-server `severityThreshold` (error/warning/info). Retries up to 3 times with session-stored retry counters. Trust-gated — untrusted projects skip LSP audit (returns `{ proceed: true }` with warning, matching VS Code Restricted Mode precedent).

**Location:** `.pi/extensions/lsp-auditor/`
