# Check Extensions

**Catch API breakage before it breaks your extensions.** Audits all `.pi/extensions/` against pi's CHANGELOG — detects removed APIs, renamed hooks, deprecated patterns, and generates migration snippets.

## Why

Pi releases can introduce breaking changes. An extension using `ctx.ui.setFooter` that worked in v0.78.0 might fail silently in v0.79.0. Check Extensions automates the audit:

- Parses pi CHANGELOG.md for breaking change entries
- Scans every extension in `.pi/extensions/` with ast-grep AST analysis
- Detects removed API calls, renamed hooks, signature changes
- Generates per-extension migration snippets
- Sends structured findings to LLM for evaluation and issue creation

Manual auditing across 17+ extensions after every pi update is impractical. This extension makes it a one-command operation.

## How it works

1. **Trigger** — User runs `/check-extensions` in the Pi TUI (trust gate: only runs when project is trusted)
2. **Changelog parse** — Reads pi's `CHANGELOG.md` from node_modules, extracts breaking change entries with affected API names and version transitions
3. **Extension scan** — Walks `.pi/extensions/`, reads each extension's source files, builds an AST (via ast-grep) of all pi API imports and usage
4. **Cross-reference** — Matches each extension's API usage against the changelog's breaking changes
5. **Impact scoring** — Each compatibility issue gets a score based on severity (removed API > renamed > deprecated)
6. **Issue evaluation** — Sends structured findings to the LLM agent via `pi.sendUserMessage()` for evaluation and issue creation

### Pipeline modules

| Module | Responsibility |
|--------|----------------|
| `changelog-parser.ts` | Parse pi CHANGELOG.md into structured entries |
| `ast-scanner.ts` | AST analysis of extension source files |
| `manifest-reader.ts` | Read extension package.json/pi manifest |
| `impact-scorer.ts` | Score compatibility issues by severity |
| `migration-generator.ts` | Generate old→new migration code snippets |


## Install

Part of Cheasee-Pi monorepo. Activated automatically.

## Requirements

- Pi Coding Agent ≥ 0.78.0
- ast-grep installed (`npm i -g @ast-grep/cli`)
- Project must be trusted (`/trust`)


## Details

### Architecture

Modular pipeline for CHANGELOG-based API breakage detection:

```
├── index.ts               # Entry: /check-extensions command, arg parsing
├── pipeline.ts            # runPipeline: orchestrator for all phases
├── changelog-parser.ts    # Parse pi CHANGELOG.md for breaking change entries
├── ast-scanner.ts         # ast-grep scan of .pi/extensions/ for API usage
├── manifest-reader.ts     # Read extension package.json and README
├── change-resolver.ts     # Cross-reference API usage vs changelog entries
├── impact-scorer.ts       # Score compatibility issues by severity
├── migration-generator.ts # Generate old to new code migration snippets
├── resolve-astgrep.ts     # Resolve ast-grep binary path
├── constants.ts           # Severity enum, threshold values
├── types.ts               # All interfaces
└── test/                  # Pipeline + parser tests
```

### Pipeline Flow

```mermaid
flowchart TD
    A[/check-extensions] --> B{Project trusted?}
    B -- no --> C[Notify: cannot scan]
    B -- yes --> D[Phase 1: Parse CHANGELOG.md]
    D --> E[Extract breaking changes: removed, renamed, deprecated]
    E --> F[Phase 2: Walk .pi/extensions/]
    F --> G[manifest-reader: read package.json + README]
    G --> H[ast-scanner: ast-grep scan for API usage]
    H --> I[Phase 3: Cross-reference]
    I --> J[change-resolver: match usage to changelog]
    J --> K[Phase 4: Score by severity]
    K --> L[impact-scorer: removed > renamed > deprecated]
    L --> M[Phase 5: Generate migration snippets]
    M --> N[Phase 6: Evaluate findings with LLM]
    N --> O[LLM creates issue via pi.sendUserMessage]
```

### Severity Scoring

| Severity | Weight | Example |
|----------|--------|---------|
| `removed` | 100 | API no longer exists |
| `renamed` | 50 | API renamed with new signature |
| `deprecated` | 25 | API deprecated with alternative |
| `changed` | 10 | Signature changed |

Overall score = sum of severity weights. Issue generated when score > 0.

### Key Design Decisions

- **CHANGELOG-based detection** — Parses pi's `CHANGELOG.md` from `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`. Breaking changes marked with `!` in headings.
- **ast-grep for usage scanning** — More precise than text search, finds actual calls/imports not comment mentions.
- **Dry-run via `--dry-run`** — Future flag support in `parseCheckExtensionsArgs()`.
- **Trust gate** — Only scans when project is trusted.
- **Local `parseArgs` wrapper** — Mirrors pi v0.78.0+ API. Replace with `import { parseArgs }` on upgrade.
- **Per-extension GitHub issues** — Each gets issue with: affected files+lines, old to new migration snippets, severity breakdown, changelog link.

## License

MIT
