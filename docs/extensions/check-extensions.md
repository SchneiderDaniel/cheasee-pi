---
layout: default
title: Check Extensions
parent: Extensions
nav_order: 16
---

# Check Extensions

{: .no_toc }

[📄 README](../../.pi/extensions/check-extensions/README.md)

**Why.** Pi releases can break extensions silently — removed APIs, renamed hooks, deprecated signatures. Check Extensions automates auditing all `.pi/extensions/` against pi's CHANGELOG, detects breakage, and generates migration snippets with GitHub issues.

**How it works.** Triggered via `/check-extensions` (trust-gated). Pipeline runs: parses pi's CHANGELOG.md from node_modules for breaking change entries → walks `.pi/extensions/` and scans each extension with ast-grep AST analysis → cross-references extension API usage against changelog entries → scores each compatibility issue by severity (removed > renamed > deprecated) → generates structured GitHub issue per affected extension with affected files/lines and old→new migration code snippets.

**Location:** `.pi/extensions/check-extensions/`

## Details

### Architecture

Modular pipeline for CHANGELOG-based API breakage detection:

```
├── index.ts               # Entry: /check-extensions command, arg parsing
├── pipeline.ts            # runPipeline: orchestrator for all phases
├── changelog-parser.ts    # Parse pi's CHANGELOG.md for breaking change entries
├── ast-scanner.ts         # ast-grep scan of .pi/extensions/ for API usage patterns
├── manifest-reader.ts     # Read extension package.json and README for metadata
├── change-resolver.ts     # Cross-reference API usage against changelog entries
├── impact-scorer.ts       # Score compatibility issues by severity (removed > renamed > deprecated)
├── migration-generator.ts # Generate old→new code migration snippets
├── issue-builder.ts       # Build structured GitHub issue body
├── resolve-astgrep.ts     # Resolve ast-grep binary path
├── constants.ts           # Severity enum, threshold values
├── types.ts               # All interfaces
└── test/                  # Pipeline + parser tests
```

### Pipeline Flow

```mermaid
flowchart TD
    A[/check-extensions command] --> B{Project trusted?}
    B -- no --> C[Notify: cannot scan untrusted project]
    B -- yes --> D[Phase 1: Parse CHANGELOG.md]
    D --> E[Extract breaking changes: removed APIs, renamed hooks, deprecated signatures]
    E --> F[Phase 2: Walk .pi/extensions/]
    F --> G[manifest-reader: read package.json + README]
    G --> H[ast-scanner: ast-grep scan for API usage]
    H --> I[Phase 3: Cross-reference API usage vs changelog]
    I --> J[change-resolver: match usage to changelog entries]
    J --> K[Phase 4: Score by severity]
    K --> L[impact-scorer: removed > renamed > deprecated]
    L --> M[Phase 5: Generate migration snippets]
    M --> N[Phase 6: Build GitHub issue]
    N --> O[Create issue via gh CLI]
```

### Severity Scoring

| Severity | Weight | Example |
|----------|--------|---------|
| `removed` | 100 | API no longer exists in pi |
| `renamed` | 50 | API renamed with new signature |
| `deprecated` | 25 | API deprecated with alternative |
| `changed` | 10 | API signature changed (parameter order, type) |

Overall extension score = sum of severity weights. Issues generated when score > 0.

### Key Design Decisions

- **CHANGELOG-based detection (not version comparison)** — Parses pi's `CHANGELOG.md` from `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`. Breaking changes listed in markdown headings with `!` marker (e.g., `### ! Removed registerExtension`).
- **ast-grep for usage scanning** — Uses `ast-scanner.ts` with ast-grep to find API usage patterns in extension code. More precise than text search — finds actual calls/imports, not comment mentions.
- **Dry-run via `--dry-run` flag** — Future flag support in `parseCheckExtensionsArgs()`. Currently parses flags but does not use them. Establishes argument infrastructure.
- **Trust gate** — Only scans project-local extensions when project is trusted. Prevents reading arbitrary file system via changelog path resolution.
- **Local `parseArgs` wrapper** — Mirrors `@earendil-works/pi-coding-agent` v0.78.0+ API. When pi upgrades to >=0.78.0, replace with `import { parseArgs }`.
- **Per-extension GitHub issues** — Each affected extension gets its own GitHub issue with:
  - Affected files and line numbers
  - Old → new migration code snippets
  - Severity breakdown
  - Link to CHANGELOG entry

### Output Format

Generated GitHub issue body:

```markdown
## Extension Compatibility Report: <name>

**Scanned against:** pi v0.XX.X
**Scan date:** YYYY-MM-DD

### Issues Found

| Severity | API | File | Line |
|----------|-----|------|------|
| removed | `oldFunction()` | src/index.ts | 42 |

### Migration

**Before:**
```ts
pi.oldFunction({...});
```

**After:**
```ts
pi.newFunction({...});
```

### Details

CHANGELOG: `<link to changelog entry>`
```

### Testing

Tests cover:
- CHANGELOG parsing: markdown headings, severity markers, version extraction
- AST scanning: API usage detection, import resolution, multi-file extensions
- Change resolution: exact match, fuzzy match, no-match edge cases
- Impact scoring: severity weights, threshold gating, cumulative scoring
- Migration generation: simple rename, signature change, complex migration
- Issue building: markdown formatting, file references, code snippets
- Pipeline integration: full end-to-end with mock changelog + mock extension
