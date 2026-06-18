# Check Extensions

**Catch API breakage before it breaks your extensions.** Audits all `.pi/extensions/` against pi's CHANGELOG — detects removed APIs, renamed hooks, deprecated patterns, and generates migration snippets.

## Why

Pi releases can introduce breaking changes. An extension using `ctx.ui.setFooter` that worked in v0.78.0 might fail silently in v0.79.0. Check Extensions automates the audit:

- Parses pi CHANGELOG.md for breaking change entries
- Scans every extension in `.pi/extensions/` with ast-grep AST analysis
- Detects removed API calls, renamed hooks, signature changes
- Generates per-extension migration snippets
- Creates structured GitHub issues for affected extensions

Manual auditing across 17+ extensions after every pi update is impractical. This extension makes it a one-command operation.

## How it works

1. **Trigger** — User runs `/check-extensions` in the Pi TUI (trust gate: only runs when project is trusted)
2. **Changelog parse** — Reads pi's `CHANGELOG.md` from node_modules, extracts breaking change entries with affected API names and version transitions
3. **Extension scan** — Walks `.pi/extensions/`, reads each extension's source files, builds an AST (via ast-grep) of all pi API imports and usage
4. **Cross-reference** — Matches each extension's API usage against the changelog's breaking changes
5. **Impact scoring** — Each compatibility issue gets a score based on severity (removed API > renamed > deprecated)
6. **Issue generation** — Creates a structured GitHub issue per affected extension with:
   - The breaking change and version
   - The affected file(s) and line(s)
   - Generated migration snippet showing old → new API usage
   - Estimated fix complexity

### Pipeline modules

| Module | Responsibility |
|--------|----------------|
| `changelog-parser.ts` | Parse pi CHANGELOG.md into structured entries |
| `ast-scanner.ts` | AST analysis of extension source files |
| `manifest-reader.ts` | Read extension package.json/pi manifest |
| `impact-scorer.ts` | Score compatibility issues by severity |
| `migration-generator.ts` | Generate old→new migration code snippets |
| `issue-builder.ts` | Build GitHub issue body from findings |

## Install

Part of Cheasee-Pi monorepo. Activated automatically.

## Requirements

- Pi Coding Agent ≥ 0.78.0
- ast-grep installed (`npm i -g @ast-grep/cli`)
- Project must be trusted (`/trust`)
- GitHub CLI (`gh`) for issue creation

## License

MIT
