# PRD: ripgrep-search Refactoring

## Summary

Refactor `.pi/extensions/ripgrep-search.ts` from a 806-line monolith into a directory module with < 300 lines per file. Extract pure functions (parsing, validation, config, arg building) into dedicated modules. Keep external contracts intact: tool name `ripgrep_search`, parameters, output format, config schema, and agent references all unchanged.

## Current State Audit

### File Overview

| File                               | Lines | Issues                                            |
| ---------------------------------- | ----- | ------------------------------------------------- |
| `.pi/extensions/ripgrep-search.ts` | 806   | M1 (>300), mixed concerns                         |
| `test/ripgrep-search.test.mts`     | 1362  | inline copies of pure functions (divergence risk) |

### Anti-Patterns Found

| #   | Rule                                     | Location                                                     | Severity |
| --- | ---------------------------------------- | ------------------------------------------------------------ | -------- |
| M1  | Target < 300 lines per file              | Entire file (806 lines)                                      | 🟠 P1    |
| M4  | Entry point is thin — only registrations | Entry has tool execution logic inline                        | 🟠 P1    |
| M5  | Extraction order: types first            | All types inline                                             | 🟡 P2    |
| M7  | Re-export for testability                | Tests maintain duplicate inline copies of all pure functions | 🟡 P2    |
| —   | No `any` types                           | Clean ✅                                                     | —        |
| —   | `details` uses `Record<string, unknown>` | Clean ✅                                                     | —        |
| C4  | State encapsulated in closure            | Clean ✅ (rgAvailable, searchConfig inside closure)          | —        |
| C5  | Explicit return type annotations         | Clean ✅ (`: void` on default export)                        | —        |
| C6  | No sync I/O at module init               | Clean ✅ (readFileSync deferred to session_start)            | —        |

### External Contracts (Preserved)

| Contract                                      | Type            | References                             |
| --------------------------------------------- | --------------- | -------------------------------------- |
| Tool name `ripgrep_search`                    | Agent tool name | All 5 agent `.md` files, system prompt |
| Parameters: `query`, `directory`, `max_count` | Tool params     | Inline in extension registration       |
| Config key `search` in `.pi/settings.json`    | Config          | `loadSearchConfig()`                   |
| Output format `{ total_returned, results[] }` | Tool result     | All consumers                          |
| `--exclude-dir` list for grep fallback        | Internal        | `buildGrepArgs()`                      |
| `--max-columns`, `--max-count`, `--vimgrep`   | Internal        | `buildRgArgs()`                        |

## Architecture

### Structure

```
.pi/extensions/ripgrep-search/
├── index.ts          # Entry: registrations, events, render (< 150 lines)
├── types.ts          # Shared types: RgMatch, RgResult, SearchConfig (~30 lines)
├── config.ts         # Config loading + backend resolution (~80 lines)
├── backends.ts       # Backend build + parse: ripgrep (--vimgrep) and grep (-rnH) (~200 lines)
├── validate.ts       # Query validation, collision rules (~45 lines)
└── temp.ts           # Temp dir tracking + lifecycle cleanup (~35 lines)
```

### Dependency Graph

```
types.ts          (zero deps)
├── config.ts     (imports types)
├── backends.ts   (imports types)
├── validate.ts   (imports nothing — standalone)
├── temp.ts       (imports nothing — standalone)
└── index.ts      (imports types, config, backends, validate, temp)
```

No circular imports. Pure modules (backends, validate, temp) import zero pi SDK (backends imports only types.ts).

### Tools

#### `ripgrep_search`

- **Description**: Search codebase for literal text or regex patterns using ripgrep
- **Parameters**:
  - `query` (string, required) — literal text or regex
  - `directory` (string, optional, default ".") — scope
  - `max_count` (number, optional, default 10) — per-file limit
- **Returns**: `{ total_returned, results[]: { file, line, column, text } }`
- **promptSnippet**: "Search codebase for literal text or regex using ripgrep"
- **promptGuidelines**: Unchanged from current

### Lifecycle Hooks

| Event                | Action                                                       |
| -------------------- | ------------------------------------------------------------ |
| `session_start`      | Load config from `.pi/settings.json`, detect rg availability |
| `session_shutdown`   | Clean up tracked temp directories                            |
| `before_agent_start` | Inject backend-status note into system prompt                |

### State Management

Module-level mutable state inside closure (unchanged pattern):

- `rgAvailable: boolean | null` — cached rg detection
- `searchConfig: SearchConfig | null` — cached config
- `backendNoteInjected: boolean` — dedup injection

### Error Handling

| Error Scenario                     | Handling                                                                |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Invalid query (structural pattern) | Return `isError: true` with descriptive message mentioning correct tool |
| Directory not found                | Return `isError: true` with directory listing fallback                  |
| rg/grep exit code 1 (no matches)   | Return empty results, success                                           |
| rg/grep exit code 2+ (error)       | Return `isError: true` with stderr, tool-missing detection              |
| Output exceeds buffer limit        | Save to temp file, return truncated content with path                   |

## Implementation Details

### Key TypeScript Interfaces

```typescript
/** Single parsed vimgrep result entry */
export interface RgMatch {
	file: string;
	line: number;
	column: number;
	text: string;
}

/** Shaped output for tool result */
export interface RgResult {
	total_returned: number;
	results: RgMatch[];
	truncated?: boolean;
}

/** Search configuration from .pi/settings.json */
export interface SearchConfig {
	searchBackend: "auto" | "ripgrep" | "grep";
	maxLineLength: number;
}
```

### File-by-File Breakdown

| File          | Purpose                                                         | ~Lines |
| ------------- | --------------------------------------------------------------- | ------ |
| `types.ts`    | RgMatch, RgResult, SearchConfig interfaces                      | 30     |
| `config.ts`   | `loadSearchConfig()`, `resolveBackend()`, `ripgrepAvailable()`  | 80     |
| `backends.ts` | `buildRgArgs()`, `buildGrepArgs()`, `parseVimgrepOutput()`, `parseGrepOutput()` | ~200   |
| `validate.ts` | `validateQuery()` — collision rule logic                        | 45     |
| `temp.ts`     | `registerTempDir()`, `cleanupTrackedTempDirs()`                 | 35     |
| `index.ts`    | Default export, event hooks, tool registration, execute, render | 250    |

Total: ~560 lines (vs 806 in monolith) — reduction from de-duplicated import/type overhead.

### Test Strategy

**Phase 1 — Reexport pure functions from modules**
After extracting modules, update `test/ripgrep-search.test.mts` to `import` from `../../.pi/extensions/ripgrep-search/backends.ts` etc. instead of maintaining inline copies. This eliminates the 1362-line test duplication.

**Phase 2 — Integration test**
Keep the existing rg-binary integration test. Update imports.

### Dependencies

- **npm**: None new. Already uses `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.
- **Binaries**: `rg` (optional), `grep` (fallback).

### Best Practices Compliance

| Rule                                     | Status | Notes                                   |
| ---------------------------------------- | ------ | --------------------------------------- |
| No `any` on API boundaries               | ✅     | Already clean                           |
| `details` uses `Record<string, unknown>` | ✅     | Already clean                           |
| State encapsulated in closure            | ✅     | Already clean                           |
| Explicit return type annotations         | ✅     | Already clean                           |
| No sync I/O at module init               | ✅     | Already clean                           |
| `AbortController` for spawn timeout      | ✅     | Uses `pi.exec()` with `signal`          |
| Child process `error` events handled     | ✅     | `pi.exec` handles errors                |
| `catch` uses `instanceof Error`          | ✅     | Uses `err as { code?: string }` pattern |
| `import()` not `require()`               | ✅     | Already ESM                             |
| Files < 300 lines, entry < 150 lines     | ✅     | Max file ~250 lines                     |
| No circular imports                      | ✅     | Dependency graph is a DAG               |
| Entry point is registrations only        | ✅     | Business logic extracted to modules     |
| C10: `.ts` extension on local imports    | ✅     | All imports use `.ts`                   |
| C13: Underscore unused params            | ✅     | Existing pattern preserved              |
| C14: Inline destructured param types     | ✅     | Already in place                        |

## Migration Plan

### Step-by-Step

1. **Create directory** `.pi/extensions/ripgrep-search/`
2. **Extract `types.ts`** — interfaces only, zero deps
3. **Extract `config.ts`** — config loading + backend resolution
4. **Extract `backends.ts`** — backend build+parse: `buildRgArgs()`, `buildGrepArgs()`, `parseVimgrepOutput()`, `parseGrepOutput()` (pure)
5. **Extract `validate.ts`** — query validation (pure)
6. **Extract `temp.ts`** — temp dir tracking + cleanup
7. **Rewrite `index.ts`** — imports all modules, contains only entry logic, tool registration, execute, renders
8. **Verify**: `pi -e .pi/extensions/ripgrep-search/index.ts -p "test"` loads without error
9. **Delete** old monolith `.pi/extensions/ripgrep-search.ts`
10. **Update benchmark script** path: `ripgrep-search.ts` → `ripgrep-search/index.ts`
11. **Update tests**: import from modules instead of inline copies
12. **Final verification**: run tests + extension loads in real session

### Backward Compatibility

| Contract                                     | Preserved? | Notes                                        |
| -------------------------------------------- | ---------- | -------------------------------------------- |
| Tool name `ripgrep_search`                   | ✅         | Unchanged                                    |
| Parameters `query`, `directory`, `max_count` | ✅         | Unchanged                                    |
| Output format                                | ✅         | Unchanged                                    |
| Config key `search` in settings.json         | ✅         | Unchanged                                    |
| Agent extensions lists                       | ✅         | Pi discovers both `.ts` and `*/index.ts`     |
| Benchmark script path                        | ⚠️ Updated | `.ts` → `index.ts`                           |
| System prompt backend note                   | ✅         | Same injection logic in `before_agent_start` |

### Rollback Plan

- Keep original `.pi/extensions/ripgrep-search.ts` until final verification passes
- If directory module fails, restore by deleting directory and restoring `.ts` file
- Test passes: `pi -e .pi/extensions/ripgrep-search/index.ts -p "greet"` loads cleanly
