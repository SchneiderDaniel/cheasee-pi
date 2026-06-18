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

## Details

### Architecture

Wraps TypeScript watch compiler API in an incremental diagnostic cache:

```
├── index.ts      # Entry: /check command, lazily create watcher, mode-adapted output
├── watcher.ts    # DiagnosticsWatcher: createWatchProgram, getDiagnostics, getTrend, stop
├── adapter.ts    # TscWatchAdapter: createDefaultAdapter, diagnosticToTscDiagnostic, resolveDiagnosticFilePath
├── checkpoint.ts # runTscCheckpoint: orchestrated checkpoint for supervisor pipeline
├── format.ts     # formatDiagnostics, formatDiagnosticsJson, formatTscDiagnostics, formatTrend
├── types.ts      # TscDiagnostic, TscWatchOptions, DiagnosticTrend, TscCheckpointResult
└── test/         # Watcher + formatter tests
```

### Execution Flow

```mermaid
flowchart TD
    A[/check command] --> B{tsconfig.json exists?}
    B -- no --> C[Notify: no tsconfig.json, skip]
    B -- yes --> D{Project trusted?}
    D -- no --> E[Notify: skip for untrusted]
    D -- yes --> F{Watcher exists?}
    F -- no --> G[new DiagnosticsWatcher(tsconfigPath)]
    G --> H[watcher.start: ts.createWatchProgram]
    F -- yes --> I{Watcher running?}
    I -- no --> H
    I -- yes --> J[watcher.getDiagnostics]
    H --> J
    J --> K[watcher.getTrend: compare vs previous]
    K --> L{diagnostics.length > 0?}
    L -- no --> M[Notify: ✓ No type errors]
    L -- yes --> N[formatDiagnostics: markdown with clickable paths]
    N --> O[Notify: N errors + trend direction]
    
    J -.-> P[On file change: ts updater diagnostics]
    P --> J
    
    Q[session_shutdown] --> R[watcher.stop: closeProgram]
```

### Key Design Decisions

- **Lazy watcher creation** — `DiagnosticsWatcher` created on first `/check` call, not on `session_start`. Avoids starting `ts.createWatchProgram()` for sessions that never call `/check`.
- **Incremental watch mode** — `ts.createWatchProgram()` runs in background. File changes trigger incremental re-check. Subsequent `/check` calls return cached diagnostics instantly — no re-compilation.
- **Error trending** — `getTrend()` compares current vs previous error count. Returns `"regressed"` (more errors), `"improved"` (fewer), or `"stable"` (same). Previous count is from the most recent `/check` call.
- **Watcher lifecycle** — `watcher.stop()` called on `session_shutdown`. Prevents file watcher leaks (TypeScript's watch program holds fs watchers on the project dir).
- **Mode-adapted output** — TUI: markdown with clickable `file://` paths. JSON/RPC/Print: structured JSON `{ type: "tsc-checkpoint", files: [{path, issues}] }`.
- **Trust gate** — Untrusted projects skip watcher creation. Prevents running `tsc` against potentially unsafe project-local `tsconfig.json` configurations.
- **Backward-compatible exports** — All sub-module functions re-exported for supervisor pipeline imports. `formatTscDiagnostics` marked deprecated in favor of `formatDiagnostics`.

### DiagnosticsWatcher Internals

```typescript
class DiagnosticsWatcher {
  private program: ts.WatchOfConfigFile<ts.SemanticDiagnosticsBuilderProgram> | null = null;
  private diagnostics: TscDiagnostic[] = [];
  private previousCount: number = 0;

  start(): void {
    this.program = ts.createWatchProgram(this.host);
  }

  getDiagnostics(): TscDiagnostic[] {
    // Returns cached diagnostics from last compilation
    return this.diagnostics;
  }

  getTrend(): DiagnosticTrend {
    const current = this.diagnostics.length;
    const direction = current > this.previousCount ? 'regressed'
      : current < this.previousCount ? 'improved'
      : 'stable';
    this.previousCount = current;
    return { current, previous: this.previousCount, direction };
  }

  stop(): void {
    this.program?.close();
    this.program = null;
  }
}
```

### Diagnostic File Path Resolution

`resolveDiagnosticFilePath()` converts TypeScript's absolute paths to project-relative paths for display. Supports source files in the project root and in subdirectories.

### Testing

Tests cover:
- Watcher: start, getDiagnostics, getTrend (all 3 directions), stop
- Adapter: diagnosticToTscDiagnostic mapping, file path resolution
- Formatter: markdown output, JSON output, trend formatting
- Trust gate: trusted → allow, untrusted → skip
- Missing tsconfig.json handling
- Watcher lifecycle (start → stop → restart)
