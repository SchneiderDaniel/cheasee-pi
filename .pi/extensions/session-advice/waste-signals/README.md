# waste-signals — Session Waste Detectors

Eight pure detector functions that analyze `SessionData` and return `WasteSignal[]`.
Each detector identifies a specific pattern of wasted tokens/cost in an agent session.

## Input / Output Contract

- **Input:** `SessionData` (parsed session with tool calls, file reads, errors, etc.)
- **Output:** `WasteSignal[]` (array of detected waste signals, each with `signal` type,
  `context` tool info, `wastedTokens`, `wastedCost`, `occurrences`, `details`, and optional `turnRange`)

## Detector Inventory

| # | File | Function | Signal |
|---|------|----------|--------|
| D1 | `redundant-reads.ts` | `detectRedundantReads` | Same file path read within 2 turns |
| D2 | `identical-args.ts` | `detectIdenticalArgs` | Same tool + same args 3+ times in last 12 calls |
| D3 | `bash-grep.ts` | `detectBashGrep` | `bash` with `grep`/`rg`/`find` where `ripgrep_search` tool exists |
| D4 | `bash-cat.ts` | `detectBashCat` | `bash` with `cat`/`head`/`tail` where `read` tool exists |
| D5 | `error-loop.ts` | `detectErrorLoop` | Tool error followed by retrying same tool with same args |
| D6 | `no-batch.ts` | `detectNoBatch` | 3+ consecutive same-tool calls in different turns (could batch) |
| D7 | `turn-inefficiency.ts` | `detectTurnInefficiency` | Turns with 0 file changes but many tool calls |
| D8 | `structural-underuse.ts` | `detectStructuralSearchUnderuse` | Code file reads/edits without `structural_search` |

## Composition

All 8 detectors are composed in `session-analyzer.ts` (`analyzeSession`), which
runs each detector, deduplicates overlapping signals, and sorts by `wastedTokens`
descending. No detector imports another — each is an independent pure function.

## Constraints

- All detectors are **pure functions** — no I/O, no side effects, no `node:fs`.
- Each detector must return `WasteSignal[]` (empty array when no waste is found).
- Detectors are type-stripping compatible: no enums, no namespaces, no parameter properties.
