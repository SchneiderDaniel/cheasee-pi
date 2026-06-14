# @agentcastle/piignore

**Stop the AI from touching your sensitive files.** Define `.piignore` patterns (gitignore format) in your project root — piignore intercepts `read`, `write`, `edit`, `bash`, and other tools and blocks any operation targeting matching paths.

## Features

- **Tool interception** — Blocks `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` when a path matches `.piignore` patterns
- **`.piignore` file format** — Same syntax as `.gitignore` (supports `*`, `**`, `?`, `!` negation, directory-only `/` suffix)
- **Hierarchical loading** — Walks up from project root to filesystem root, merging all `.piignore` files
- **Bash path detection** — Tokenizes bash commands and checks file-like arguments against ignore patterns (skips URLs, package names, echo/printf strings)
- **Trust gate** — When the project is not trusted, `.piignore` patterns are ignored and a hardcoded safe-default block list is used instead, preventing attacker-controlled `.piignore` files from controlling path access
- **Safe-default block list** — Always blocks `*.env`, `.env.*`, `secrets/`, `**/*.pem`, `**/*.key` on untrusted projects, regardless of `.piignore` contents
- **Mode-aware blocking** — In non-TUI modes (JSON, RPC, print), notifications are suppressed and block reasons include full context about the source and mode
- **Pattern reload** — Re-reads `.piignore` on `/reload` via `resources_discover` event
- **Notifications** — Shows a warning toast when a path is blocked (TUI/RPC modes with UI)
- **Zero dependencies** — Pure Node.js built-ins, no npm deps

## How it works

1. Place a `.piignore` file in your project root with gitignore-style patterns
2. On session start and reload, piignore loads all `.piignore` files walking up the directory tree
3. Before every `read`, `write`, `edit`, `grep`, `find`, `ls`, or `bash` tool call executes, piignore checks the target path(s) against loaded patterns
4. If a path matches, the tool call is blocked with a `block: true` response and a reason message
5. The user sees a warning notification in the TUI

## Install

```bash
pi install npm:@agentcastle/piignore
```

Then run `/reload` or restart pi.

## Usage

### Create `.piignore` in project root

```gitignore
# Standard patterns (gitignore format)
.env
.env.*
secrets/
**/*.pem
config/credentials.*

# Negation: allow specific file even if parent is ignored
!config/credentials.example.json

# Directory-only: ignore all files inside node_modules/
node_modules/
```

### What happens

```
read(.env)                    → Blocked: Path ".env" matches .piignore patterns
write(secrets/key)            → Blocked: Path "secrets/key" matches .piignore patterns
bash(cat .env)                → Blocked: Path ".env" matches .piignore patterns
bash(npm install)             → Allowed (npm packages are not file paths)
bash(echo "hello")            → Allowed (echo args treated as literals)
bash(echo x && cat .env)      → Blocked: ".env" checked independently in cat segment
```

### Safe operations

- URLs (`https://...`, `s3://...`) are never treated as paths
- npm scoped packages (`@scope/package`) are excluded
- Shell operators (`|`, `;`, `&&`, `||`) are not checked
- Echo/printf arguments are treated as string literals within their own command segment
- Commands chained after `&&`, `||`, `;`, or `|` are checked independently — echo/printf exclusion does not poison subsequent commands

## Requirements

- Pi Coding Agent >= 0.79.1 (for `ctx.isProjectTrusted()` and `ctx.mode`)
- No external dependencies — pure Node.js built-ins
- Optional: a `.piignore` file in your project root

## Trust Model

When a project is **trusted** (`ctx.isProjectTrusted()` returns `true`):
- piignore loads and enforces `.piignore` patterns as before
- All matching paths are blocked with a notification

When a project is **not trusted** (`ctx.isProjectTrusted()` returns `false` or `undefined`):
- `.piignore` patterns are **not honored** — prevents attacker-controlled patterns
- A hardcoded safe-default block list is enforced instead:
  - `*.env` — all `.env` files
  - `.env.*` — environment variable files
  - `secrets/` — secrets directory
  - `**/*.pem` — private key certificates
  - `**/*.key` — SSH/private keys
- Non-sensitive paths like `README.md`, `src/`, `package.json` remain accessible

If `ctx.isProjectTrusted()` is unavailable (older Pi version) or throws an error,
the handler treats the project as untrusted (fail-closed) and applies safe-defaults.

## Global Companion (Optional)

The companion extension `global-companion.ts` participates in the `project_trust`
event to warn about potentially problematic `.piignore` patterns before trust is
granted. It does **not** make trust decisions — it only observes and warns.

### Detects

- **Restrictive patterns** — `*`, `**`, `/`, `/*`, `/**` that match everything
- **Unanchored generic directories** — `build/`, `dist/`, `tmp/`, `cache/`, `logs/`,
  `node_modules/` and other commonly auto-generated directories that may block
  important paths at any depth
- **Broad file-type globs** — `*.log`, `*.db`, `*.sqlite`, `*.tar`, `*.zip`,
  `*.lock` and other non-essential file types matched project-wide
- **Name-heuristic patterns** — `**/*secret*`, `**/*token*`, `**/*password*`
  and similar patterns that match based on filename substring heuristics

All warnings are grouped into a single notification to avoid warning fatigue.

### Install

```bash
cp .pi/extensions/piignore/global-companion.ts ~/.pi/agent/extensions/piignore-trust-check.ts
```

Requires Pi v0.79.0+ (for the `project_trust` event).

## License

MIT
