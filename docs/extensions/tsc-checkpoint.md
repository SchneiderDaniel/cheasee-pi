---
layout: default
title: TSC Checkpoint
parent: Extensions
nav_order: 12
---

# TSC Checkpoint

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/tsc-checkpoint/README.md)

**Why.** Incremental TypeScript type-checking with watch mode. First `/check` spawns the compiler; subsequent calls return cached diagnostics instantly. Tracks error trends (regression/improvement/stable). Used by supervisor pipeline as quality gate between Implementation and Audit.

**How it works.** Triggered via `/check` command. Checks project trust and `tsconfig.json` existence. Lazy-initializes `DiagnosticsWatcher` wrapping TypeScript's watch compiler API (`ts.createWatchProgram()`). `watcher.getDiagnostics()` returns all current cached diagnostics. `watcher.getTrend()` compares current vs previous error count → outputs `regressed`/`improved`/`stable`. TUI mode: markdown with clickable `file://` paths. JSON mode: structured `{ files: [{path, issues: [{line, col, severity, message}]}] }`. Watcher stopped on session shutdown to prevent file watcher leaks.

**Location:** `.pi/extensions/tsc-checkpoint/`
