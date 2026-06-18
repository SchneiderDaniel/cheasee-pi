---
layout: default
title: Ripgrep Search
parent: Extensions
nav_order: 2
---

# Ripgrep Search

{: .no_toc }

[📄 README](../../.pi/extensions/ripgrep-search/README.md) — [`@cheasee-pi/ripgrep-search` on npm](https://www.npmjs.com/package/@cheasee-pi/ripgrep-search)

**Why.** Fast literal/regex code search that respects `.gitignore`, returns structured summaries with match counts, file counts, and truncation info. Falls back to `grep` if ripgrep unavailable.

**How it works.** Registers `ripgrep_search` tool. Validates queries — rejects structural patterns (redirects to `structural_search`). Runs ripgrep with `--vimgrep` for structured output, or grep with `-rnH` as fallback. Results cached in memory by (query, directory). TUI mode renders clickable `file://` hyperlinks via OSC 8 escape sequences. Mode-adaptive output — non-TUI modes skip ANSI/OSC8 sequences. Result cache invalidated on session shutdown.

**Location:** `.pi/extensions/ripgrep-search/`

## Details

### Architecture

Dual-backend search engine with unified output format. 6 modules + test suite:

```
├── index.ts     # Entry: tool registration, backend resolution, execute, renderers
├── internal.ts  # Query validation, temp directory lifecycle, in-memory result cache (FIFO, 100 entries)
├── config.ts    # Load SearchConfig from .pi/settings.json, resolve backend, detect ripgrep on PATH
├── args.ts      # Build rg --vimgrep args or grep -rnH args (pre-escaped, no shell injection)
├── parse.ts     # Parse --vimgrep output (file:line:column:text) and grep -rnH output
├── types.ts     # RgMatch, RgResult, SearchConfig interfaces
└── test/        # Fixtures + parser tests
```

### Execution Flow

```mermaid
flowchart TD
    A[tool_call: ripgrep_search] --> B[validate.ts: reject structural patterns]
    B -- invalid --> C[Throw Error]
    B -- valid --> D[verifyDirectory: resolve + traversal check]
    D --> E[config.ts: resolveBackend]
    E --> F{backend?}
    F -- ripgrep --> G[buildRgArgs]
    F -- grep --> H[buildGrepArgs]
    G --> I[pi.exec: rg --vimgrep]
    H --> J[pi.exec: grep -rnH]
    I --> K[parseVimgrepOutput]
    J --> L[parseGrepOutput]
    K --> M[buildStructuredSummary]
    L --> M
    M --> N[internal.ts: setCachedResult]
    N --> O[Return {content, details}]
```

### Backend Resolution Strategy

| Config | rg available | Backend |
|--------|-------------|--------|
| `"auto"` | Yes | ripgrep |
| `"auto"` | No | grep |
| `"ripgrep"` | Yes | ripgrep |
| `"ripgrep"` | No | Error thrown |
| `"grep"` | Any | grep |

`ripgrepAvailable()` uses 3-tier detection:
1. **PATH directory scan** — `accessSync()` on each PATH entry for `rg` executable (zero spawn overhead)
2. **pi's own bin dir** — `~/.pi/agent/bin/rg`
3. **Spawn fallback** — `rg --version` via exec for exotic environments

### Key Design Decisions

- **`--vimgrep` output format** — `file:line:column:text` for precise navigation. Uses `-j1` (single thread) with `--vimgrep` to prevent per-thread output buffering memory blowup (research finding: `--vimgrep` + parallelism can consume 18+ GB).
- **`maxLineLength` capped at 2000** (from config). Default 200. Prevents context-window blowup from single-line cache files (e.g., 21MB `cache-index.json`).
- **Grep fallback excludes cache dirs** — `--exclude-dir=cache --exclude-dir=.cache` prevents large single-line cache files from flooding output.
- **Grep column always 1** — standard grep doesn't output column position.
- **Query validation** rejects patterns starting with `class `, `def `, `function `, or containing `$`/`{` — redirects to `structural_search`.
- **Cascade prevention** — `before_agent_start` injects backend note into system prompt so the LLM knows which search engine is active and its capabilities/limitations.

### Renderer Details

- Non-TUI modes: pass-through without ANSI/OSC8
- TUI mode: OSC 8 `file://` hyperlinks on each result line
- Expanded view: up to 20 result lines; collapsed: summary only
- Oversized output (>500 results) saved to temp file with path in output
- Temp files cleaned up on `session_shutdown` (`rm -rf` on tracked dirs)

### Cache Behavior

- In-memory FIFO Map, max 100 entries
- Key: `JSON.stringify({query, directory})` with directory normalization (trailing slash removal, `./` normalization)
- Cleared on `session_shutdown` to prevent cross-session memory bleed
- Cache also stores raw stdout for oversized output preservation
