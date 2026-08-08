---
layout: default
title: PiIgnore
parent: Extensions
nav_order: 14
---

# PiIgnore

{: .no_toc }

[📄 README](../../.pi/extensions/piignore/README.md) — [`@cheasee-pi/piignore` on npm](https://www.npmjs.com/package/@cheasee-pi/piignore)

**Why.** Blocks AI from accessing sensitive paths using `.piignore` patterns (gitignore format). Intercepts `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash` when a path matches. Trust model: when untrusted, uses hardcoded safe-defaults (blocks `*.env`, `.env.*`, `secrets/`, `**/*.pem`, `**/*.key`) instead of attacker-controlled `.piignore`.

**How it works.** Loads `.piignore` files walking up from project root to filesystem root (hierarchical loading). On every tool call, checks target paths against loaded patterns. Bash commands tokenized with shell-aware parsing — URLs, npm scoped packages, echo/printf strings are excluded from path checking. Pattern reload on `/reload` via `resources_discover` event. Shows warning toast when a path is blocked (TUI/RPC modes with UI).

A **global companion extension** (`global-companion.ts`, installable to `~/.pi/agent/extensions/`) participates in `project_trust` events to warn about overly broad patterns BEFORE trust is granted. It detects three categories of suspect patterns:
- **Unanchored generic directories** — e.g. `build/`, `tmp/`, `node_modules/` without root anchor
- **Broad file-type globs** — e.g. `*.log`, `**/*.bak` matching non-essential extensions project-wide
- **Name-heuristic patterns** — e.g. `**/*secret*`, `*token*` using sensitive keywords with wildcard adjacency

**Troubleshooting:** If `.piignore` blocks a legitimate path, add a negation pattern and reload:

```
!path/to/allow
```

Then run `/reload`.

**Location:** `.pi/extensions/piignore/`

## Details

### Architecture

Hierarchical .piignore loading with shell-aware bash path extraction:

```
├── index.ts  # Entry: tool_call handler, pattern loading, bash tokenization, path checking
└── test/     # Unit tests
```

Single-file extension. Core logic:
- `loadPiIgnore()` — Walks up from cwd to filesystem root, collecting `.piignore` files
- `patternToRegex()` — Converts gitignore pattern to RegExp
- `isIgnored()` — Checks path against all loaded patterns with negation support
- `tokenizeBashCommand()` — Shell-aware tokenization for bash commands
- `isPathLike()` — Determines if a bash token could be a file path

### Execution Flow

```mermaid
flowchart TD
    A[tool_call event] --> B{Project trusted?}
    B -- no --> C[Use SAFE_DEFAULT_BLOCK: *.env, .env.*, secrets/, **/*.pem, **/*.key]
    B -- yes --> D[Load .piignore: walk up from cwd to /]
    
    C --> E[checkPath: test against patterns]
    D --> E
    
    E --> F{Tool type?}
    F -- read/write/edit/grep/find/ls --> G[checkPath(event.input.path)]
    F -- bash --> H[tokenizeBashCommand → segmentTokens → isPathLike per segment]
    
    G --> I{Path matches pattern?}
    H --> I
    
    I -- yes --> J[Block: notify warning, return {block: true, reason}]
    I -- no --> K[Allow: pass through]
```

### Gitignore Pattern → RegExp Translation

The `patternToRegex()` function handles:

| Gitignore Pattern | Regex | Notes |
|-------------------|-------|-------|
| `*.env` | `(^|.*/)[^/]*\.env$` | No slash → matches anywhere |
| `.env.*` | `(^|.*/)\.env\.[^/]*$` | Leading dot preserved |
| `secrets/` | `(^|.*/)secrets$` | Trailing / → directory only |
| `**/*.pem` | `(.*/)?[^/]*\.pem$` | `**` matches any depth |
| `!/secret.pub` | negation | `!` prefix → negate flag |
| `build/` | `(^|.*/)build(/.*)?$` | Directory pattern |
| `[Tt]emp/` | `(^|.*/)[Tt]emp(/.*)?$` | Bracket expression preserved |
| `[!a-z]test/` | `(^|.*/)[^a-z]test(/.*)?$` | `[!...]` → `[^...]` (negation) |
| `# comment` | — | Skipped |
| `\#literal` | `^#literal$` | Escaped `\#` is literal `#` |

### Bash Tokenization Pipeline

```mermaid
flowchart LR
    A[bash command string] --> B[tokenizeBashCommand]
    B --> C[Split into tokens with quoted tracking]
    C --> D[segmentTokens: split at &&, ||, ;, |]
    D --> E[For each segment: getCommandNameFromTokens]
    E --> F[Filter path-like tokens: isPathLike]
    F --> G[checkPath each token against ignore patterns]
```

`isPathLike()` considers a token path-like if it:
- Contains `/`, `.`, or `~`
- Is NOT a flag (`-` prefix)
- Is NOT a shell operator (`|`, `;`, `&&`, `||`, `>`, `>>`, etc.)
- Is NOT a URL (`http://`, `https://`, `ftp://`, etc.)
- Is NOT an npm scoped package (`@scope/...`)
- Is NOT inside `echo`/`printf` commands (string literals, not paths)
- Does NOT contain backticks (command substitution, not files)

### Trust Model

| Trust Status | Patterns Used | Notes |
|-------------|---------------|-------|
| Trusted | `.piignore` files (hierarchical) | Project-local patterns honored |
| Untrusted | `SAFE_DEFAULT_BLOCK` (hardcoded) | Attacker-controlled `.piignore` ignored |
| `isProjectTrusted()` unavailable | Untrusted | Fail-safe: safe defaults |

### Global Companion Extension

A separate `global-companion.ts` (installable to `~/.pi/agent/extensions/`) participates in `project_trust` events to warn about overly broad patterns BEFORE trust is granted. Three suspect categories:
- **Unanchored generic directories** — `build/`, `tmp/`, `node_modules/` without root anchor (`/` prefix)
- **Broad file-type globs** — `*.log`, `**/*.bak` matching non-essential extensions project-wide
- **Name-heuristic patterns** — `**/*secret*`, `*token*` using sensitive keywords with wildcard adjacency

### Reload Support

On `/reload` command, listens to `resources_discover` event to reload all `.piignore` files from disk. Clears cached entries and re-walks from cwd to filesystem root.

### Testing

Tests cover:
- Pattern→regex translation for all gitignore edge cases
- Path matching: absolute, relative, directory-only patterns
- Negation patterns (`!` prefix)
- Bash tokenization: quoted strings, shell operators, escaped chars
- Path-like detection: URLs, npm scopes, echo commands, flags
- Hierarchical loading: multiple `.piignore` in ancestor directories
- Trust gate: trusted vs untrusted pattern sets
- Safe defaults: all 5 hardcoded patterns match expected paths
