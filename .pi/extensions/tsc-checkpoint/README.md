# TSC Checkpoint

**Incremental TypeScript type-checking with watch mode.** Runs `tsc --noEmit` on the current worktree, caches diagnostics for instant re-checks, and tracks diagnostic trends across sessions. Triggered manually with `/check`.

## Why

Waiting for full `tsc --noEmit` compilation on every check wastes precious tokens and time. TSC Checkpoint:

- **Incremental** — Uses TypeScript's watch compiler API. First `/check` spawns the compiler; subsequent calls return cached results instantly
- **Trend tracking** — Compares current error count against previous check. Detects regressions (more errors), improvements (fewer errors), or stability
- **Clickable paths** — TUI mode outputs `file://` URIs for direct navigation to error locations
- **Structured JSON** — JSON/RPC/print modes output structured `{ files: [{path, issues: [{line, col, severity, message}]}] }` for programmatic consumers
- **Trust-gated** — Skips when project is untrusted (prevents attacker-controlled `tsconfig.json` from running arbitrary commands)
- **Watcher lifecycle** — Watcher is cleaned up on session shutdown to prevent file watcher leaks

Called automatically by the Supervisor pipeline as a quality gate between Implementation → Audit transitions.

## How it works

1. **Trigger** — User runs `/check` or supervisor calls `runTscCheckpoint(worktreePath)`
2. **Trust check** — `ctx.isProjectTrusted()` gates execution. Untrusted projects get a skip message
3. **Watcher lazy init** — First `/check` creates a `DiagnosticsWatcher` that wraps TypeScript's watch compiler
4. **Start** — Calls `watcher.start()` which creates a `ts.createWatchProgram()` with the worktree's `tsconfig.json`
5. **Get diagnostics** — `watcher.getDiagnostics()` returns all current diagnostics from the cached compilation
6. **Trend** — `watcher.getTrend()` compares current count vs previous, returns `{ direction: "regressed" | "improved" | "stable", previous: number, current: number }`
7. **Format** — TUI: markdown with clickable `file://` paths. JSON/RPC/print: structured JSON
8. **Cleanup** — Watcher stopped on session shutdown

### Flow

```
/check
    │
    ├─ tsconfig.json exists? ─── No → skip message
    │
    ├─ Project trusted? ──────── No → skip message
    │
    ├─ Watcher exists? ───────── No → create + start watch compiler
    │
    ├─ getDiagnostics()
    ├─ getTrend() → compare vs previous
    │
    └─ Output (mode-adapted)
          ├─ TUI: "## TSC Checkpoint — 3 Type Error(s) Found (⚠️ regression)"
          │      + file:// formatted diagnostics
          └─ JSON: { type: "tsc-checkpoint", errors: [...], trend: {...} }
```

### Trend interpretation

| Trend | Meaning |
|-------|---------|
| `stable` | Same error count as previous check |
| `improved` | Fewer errors than previous check |
| `regressed` | More errors than previous check |

### Command

```
/check
```

No arguments. Runs against `tsconfig.json` in the current worktree root.

## Install

Part of Cheasee-Pi monorepo. Activated automatically.

## Requirements

- Pi Coding Agent ≥ 0.79.1
- TypeScript installed in the project (`npx tsc` available)
- `tsconfig.json` in worktree root
- Project must be trusted (`/trust`)

## Details

### Architecture

Wraps TypeScript watch compiler API in an incremental diagnostic cache:

```
├── index.ts      # Entry: /check command, lazily create watcher, mode-adapted output
├── watcher.ts    # DiagnosticsWatcher: createWatchProgram, getDiagnostics, getTrend, stop
├── adapter.ts    # TscWatchAdapter: createDefaultAdapter, diagnosticToTscDiagnostic, resolveFilePath
├── checkpoint.ts # runTscCheckpoint: orchestrated checkpoint for supervisor pipeline
├── format.ts     # formatDiagnostics, formatDiagnosticsJson
├── types.ts      # TscDiagnostic, TscWatchOptions, DiagnosticTrend, TscCheckpointResult
└── test/         # Watcher + formatter tests
```

### Execution Flow

```mermaid
flowchart TD
    A[/check] --> B{tsconfig.json exists?}
    B -- no --> C[Notify: skip]
    B -- yes --> D{Project trusted?}
    D -- no --> E[Notify: skip]
    D -- yes --> F{Watcher exists?}
    F -- no --> G[new DiagnosticsWatcher]
    F -- yes --> S{tsconfigPath matches watcher?}
    S -- no --> T[watcher.stop]
    T --> G
    S -- yes --> I{Watcher running?}
    G --> H[watcher.start: ts.createWatchProgram]
    I -- no --> H
    I -- yes --> J[watcher.getDiagnostics]
    H --> J
    J --> K[watcher.getTrend]
    K --> L{diagnostics.length > 0?}
    L -- no --> M[Notify: No type errors]
    L -- yes --> N[formatDiagnostics: markdown with paths]
    N --> O[Notify: N errors + trend direction]
    Q[session_shutdown] --> R[watcher.stop: closeProgram]
```

### Key Design Decisions

- **Lazy watcher creation** — `DiagnosticsWatcher` created on first `/check`, not `session_start`. Avoids starting watch program for sessions that never check.
- **Incremental watch mode** — `ts.createWatchProgram()` runs in background. File changes trigger incremental re-check. Subsequent `/check` calls return cached diagnostics instantly.
- **Error trending** — `getTrend()` compares current vs previous error count: `regressed` (more), `improved` (fewer), `stable` (same).
- **Watcher lifecycle** — `watcher.stop()` on `session_shutdown` prevents file watcher leaks.
- **Per-worktree watcher** — The watcher is keyed to the worktree's `tsconfig.json` path. Switching projects (different worktree path) invalidates the old watcher, stopping it and creating a fresh one for the new path. This prevents cross-project diagnostic contamination and leaked file watchers.
- **Mode-adapted output** — TUI: markdown with clickable `file://` paths. JSON/RPC/Print: structured JSON.
- **Trust gate** — Untrusted projects skip watcher creation. Prevents running `tsc` against unsafe project-local `tsconfig.json`.
- **Backward-compatible exports** — All sub-module functions re-exported for supervisor pipeline.

### DiagnosticsWatcher Internals

```typescript
class DiagnosticsWatcher {
  start(): void { /* ts.createWatchProgram */ }
  getDiagnostics(): TscDiagnostic[] { /* cached from last compilation */ }
  getTrend(): DiagnosticTrend { /* compare current vs previous */ }
  stop(): void { /* closeProgram */ }
}
```

## License

MIT
