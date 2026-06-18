---
layout: default
title: Format on Save
parent: Extensions
nav_order: 11
---

# Format on Save

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/format-on-save/README.md)

**Why.** Auto-formats TS/JS files with Prettier and runs ESLint diagnostics after every `write` or `edit` — no manual step needed. Catches code quality issues early, before the supervisor Audit stage.

**How it works.** Hooks `tool_result` events for write/edit. Checks file existence, size (<5MB), and project trust. Runs Prettier formatter then ESLint linter asynchronously. TUI mode shows toast notifications via `ctx.ui.notify()`, RPC sends `followUp` messages via `pi.sendUserMessage()`, JSON/print stay silent. Non-blocking — errors don't crash the session. Trust gate prevents untrusted project configs from running arbitrary formatter commands.

**Location:** `.pi/extensions/format-on-save/`

## Details

### Architecture

Adapter pattern with pluggable Formatter/Linter ports:

```
├── index.ts               # Entry: registerHandler, tool_result event wiring
├── formatting.mts         # looksLikeFilePath, MAX_FILE_SIZE_BYTES
├── eslint.mts             # formatEslintDiagnostics: diagnostic message formatting
├── eslint-adapter.mts     # EslintLinter: ESLint adapter (dynamic import)
├── prettier-adapter.mts   # PrettierFormatter: Prettier adapter (dynamic import)
├── ports.mts              # Formatter, Linter interfaces
└── test/                  # Unit + integration tests
```

### Execution Flow

```mermaid
flowchart TD
    A[tool_result: write/edit] --> B{tool isError?}
    B -- yes --> C[Skip]
    B -- no --> D{path is file path?}
    D -- no --> E[Skip (pip install, npm...)]
    D -- yes --> F{file exists?}
    F -- no --> G[Skip]
    F -- yes --> H{file < 5MB?}
    H -- no --> I[Skip]
    H -- yes --> J{project trusted?}
    J -- no --> K[Skip]
    J -- yes --> L{formatter.canHandle?}
    L -- no --> M[Skip format]
    L -- yes --> N[formatter.format]
    N -- error --> O[Notify failure]
    N -- formatted --> P[Notify success]
    N -- no change --> Q[Silent]
    
    P --> R{linter.canHandle?}
    M --> R
    Q --> R
    R -- no --> S[Skip lint]
    R -- yes --> T[linter.lint]
    T -- error --> U[Log error]
    T -- has diagnostics --> V[Send followUp message]
    T -- clean --> W[Silent]
```

### Key Design Decisions

- **Non-blocking advisory** — Format/lint errors do NOT crash session. All errors are caught and logged via `console.error`. The write/edit itself already succeeded.
- **Dynamic imports for adapters** — `PrettierFormatter` and `EslintLinter` are dynamically imported. Missing dependencies (prettier, eslint) handled gracefully inside adapters.
- **Trust gate** — Untrusted projects skip formatting/linting entirely (step J). Prevents running arbitrary formatter commands from project-local config.
- **Mode-adaptive notifications** — TUI: `ctx.ui.notify()`. RPC: `pi.sendUserMessage(followUp)`. JSON/print: `console.error` only (no notification spam).
- **Size gate (5MB)** — `MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024`. Prevents trying to format/lint large generated files.
- **File path heuristic** — `looksLikeFilePath()` checks for extensions like `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`. Rejects paths like `pip install` or `npm i`.
- **ESLint config error prefixing** — When lint error matches config error patterns (`ConfigError`, `Failed to load`, `Could not find`, `eslint.config`, `.eslintrc`, `configuration`, `Config (`), prefixes `[config error] ` in logs.
- **Diagnostic followUp deduplication** — Only sends followUp when `diagnostics.length > 0`. Clean lint results produce no output.

### Adapter Ports

```typescript
interface Formatter {
  canHandle(filePath: string): boolean;    // Check if this formatter supports the file
  format(filePath: string): Promise<{      // Format the file
    formatted: boolean;                    // true = file was changed
    error?: string;                        // Error message if format failed
  }>;
}

interface Linter {
  canHandle(filePath: string): boolean;
  lint(filePath: string): Promise<{
    diagnostics: LintDiagnostic[];
    error?: string;
  }>;
}
```

### Testing

Tests cover:
- File path heuristics (valid paths, pip install, npm commands)
- Size gate (below/above 5MB)
- Trust gate (trusted → format+lint, untrusted → skip)
- Format notification modes (TUI, RPC, JSON/print)
- Lint diagnostic formatting and followUp generation
- Error handling (formatter throws, linter unavailable, missing file)
- ESLint config error prefix detection
- Adapter mock injection for deterministic testing
