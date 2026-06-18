# @agentcastle/ripgrep-search

**Fast code search tool for Pi — literal text and regex, natively respects `.gitignore`.** Returns structured human-readable summaries with top-N results, file counts, and truncation info.

## Features

- **`ripgrep_search` tool** — Search codebase by literal text or regex pattern
  - Default 10 matches per file, configurable via `max_count`
  - Structured summary output showing top-N results with file counts and truncation indicator
  - Respects `.gitignore` natively when ripgrep is available
  - Falls back to `grep` if ripgrep not installed
  - Auto-rejects structural patterns — redirects to `structural_search`
- **Result cache** — Same query+directory returns cached result without re-running the CLI
- **Configurable backend** — Set `searchBackend` to `"auto"` (default), `"ripgrep"`, or `"grep"` in `.pi/settings.json`
- **Backend indicator** — Injects current search backend into system prompt so LLM knows which tool is active
- **Temp file handling** — Large outputs saved to temp files, cleaned up at session shutdown
- **TUI rendering** — Compact inline result display with match counts, truncation status, and clickable file paths via OSC 8 `file://` hyperlinks
- **Mode-aware rendering** — Automatically adapts output for TUI (rich, themed), JSON, RPC, and print modes; non-TUI modes pass raw text through without theme formatting or OSC 8 escape sequences

## How it works

1. The LLM calls `ripgrep_search` with a query and optional directory/max_count
2. The extension validates the query (rejects structural patterns), resolves the directory, and selects the backend (ripgrep or grep)
3. **Cache check** — If the same query+directory was already searched, the cached result is returned without re-running the CLI
4. The backend runs — ripgrep with `--vimgrep` for structured output, or grep with `-rnH` as fallback
5. Results are parsed and cached in memory for the session duration
6. A human-readable summary is returned showing top-N results (tunable via `max_count`), unique file count, and truncation status
7. Large outputs are saved to temp files with a path reference in the response; temp files and cache are cleaned up at session shutdown

## Install

```bash
pi install npm:@agentcastle/ripgrep-search
```

Then run `/reload` or restart pi.

## Usage

The LLM uses `ripgrep_search` automatically. Example invocations the LLM might make:

```
ripgrep_search(query="TODO", directory="src")
ripgrep_search(query="console\\.log", directory=".", max_count=20)
ripgrep_search(query="magic.number.42", directory=".")
```

### Configuration (optional)

In `.pi/settings.json`:

```json
{
	"ripgrepSearch": {
		"searchBackend": "auto",
		"maxLineLength": 200
	}
}
```

- `searchBackend`: `"auto"` (try ripgrep, fallback to grep), `"ripgrep"` (require), or `"grep"` (skip detection)
- `maxLineLength`: Cap line length in results (default 200)

## Requirements

- Pi Coding Agent
- ripgrep recommended (`rg` — install via `apt`, `brew`, or `choco`)
- Falls back to system `grep` if ripgrep unavailable

## ripgrep Availability Detection
The extension detects `rg` at startup in three stages:

1. **PATH scan** — walks `process.env.PATH` with `accessSync` (zero-overhead, no subprocess)
2. **Pi bin dir fallback** — checks `~/.pi/agent/bin/rg` (pi's own managed tools directory)
3. **Spawn fallback** — runs `rg --version` via subprocess (last resort)

If none succeed, the extension falls back to system `grep`.

### Common Fix: Symlink into `~/.local/bin`
If `~/.pi/agent/bin` is not on PATH (e.g. WSL interop environment mismatch):

```bash
ln -sf ~/.pi/agent/bin/rg ~/.local/bin/rg
```

`~/.local/bin` is typically on PATH and persists across sessions.

## Details

### Architecture

Dual-backend search engine with unified output format:

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
    A[tool_call] --> B[validate: reject structural patterns]
    B -- invalid --> C[Throw Error]
    B -- valid --> D[verifyDirectory: resolve + traversal check]
    D --> E[resolveBackend]
    E --> F{backend?}
    F -- ripgrep --> G[buildRgArgs]
    F -- grep --> H[buildGrepArgs]
    G --> I[exec rg --vimgrep]
    H --> J[exec grep -rnH]
    I --> K[parseVimgrepOutput]
    J --> L[parseGrepOutput]
    K --> M[buildStructuredSummary]
    L --> M
    M --> N[setCachedResult]
    N --> O[Return {content, details}]
```

### Backend Resolution

| Config | rg available | Backend |
|--------|-------------|--------|
| `"auto"` | Yes | ripgrep |
| `"auto"` | No | grep |
| `"ripgrep"` | Yes | ripgrep |
| `"ripgrep"` | No | Error thrown |
| `"grep"` | Any | grep |

`ripgrepAvailable()` uses 3-tier detection: PATH directory scan (`accessSync`), pi's own bin dir (`~/.pi/agent/bin/rg`), spawn fallback (`rg --version`).

### Key Design Decisions

- **`--vimgrep` + `-j1`** — Single thread prevents per-thread output buffering memory blowup (research finding: `--vimgrep` + parallelism can consume 18+ GB).
- **`maxLineLength` capped at 2000** (default 200). Prevents context-window blowup from large single-line files.
- **Grep fallback excludes cache dirs** — `--exclude-dir=cache --exclude-dir=.cache` prevents flooding from large cache files.
- **Query validation** rejects `class `, `def `, `function `, `$`, `{` — redirects to `structural_search`.
- **Cascade prevention** — `before_agent_start` injects backend note into system prompt describing active backend capabilities.
- **Oversized output** — >500 results saved to temp file with path reference; cleaned up on `session_shutdown`.

### Cache Behavior

- In-memory FIFO Map, max 100 entries
- Key: `JSON.stringify({query, directory})` with directory normalization
- Cleared on `session_shutdown`

## License

MIT
