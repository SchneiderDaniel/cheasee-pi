---
layout: default
title: RTK
parent: Extensions
nav_order: 19
---

# RTK

{: .no_toc }

[📄 Extension source](../../.pi/extensions/rtk/index.ts)

**Why.** Intercepts every `bash` tool call and pipes the command through `rtk rewrite` — a Rust CLI that strips noise, groups output, deduplicates, and truncates. **60-90% token savings** on common dev commands (git, cargo, ls, grep, test runners, linters, docker, kubectl). Sub-10ms overhead per rewrite.

**How it works.** Hooks `tool_call`: narrows to `bash` events, calls `pi.exec("rtk", ["rewrite", cmd])`, mutates `event.input.command` in-place if a rewrite exists. RTK binary decides which commands to rewrite and how — all logic lives in the Rust binary, not the extension. Fail-open on errors (never blocks execution). Version guard at load time (requires `rtk >= 0.23.0`). Respects `RTK_DISABLED=1` env var.

**Location:** `.pi/extensions/rtk/`

## Installation

### Binary

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
```

Installs to `~/.local/bin/rtk`. Verify: `rtk --version` (expect `>= 0.23.0`).

### Extension

The extension lives project-local at `.pi/extensions/rtk/index.ts`. Pi loads it automatically when the project is trusted. No `--extension` flag or config needed.

### Docker (container setup)

Add one line to the Dockerfile:

```dockerfile
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
```

The `.pi/extensions/rtk/index.ts` is already in the project — mounted into the container automatically.

## Details

### Architecture

```
bash "git status"
  → tool_call event
  → RTK: pi.exec("rtk", ["rewrite", "git status"])
  → rtk binary: "rtk git status" (or pass-through if no rewrite)
  → event.input.command = "rtk git status"
  → execution
```

### What gets rewritten

RTK's rewrite registry covers the most token-heavy commands. The registry is defined in the upstream Rust crate (`src/discover/registry.rs`) — add new rules there, not in the extension.

Common rewrites:
- `git status` → `rtk git status` (groups files by status, hides unchanged)
- `git diff` → `rtk git diff` (hides unchanged hunks, shows only changed)
- `git log` → `rtk git log` (compact format, one line per commit)
- `cargo build` → `rtk cargo build` (hides "Compiling" lines, shows only warnings+errors)
- `cargo test` → `rtk cargo test` (hides passing tests, shows only failures)
- `npm test` → `rtk npm test` (hides passing, shows failures)
- `docker ps` → `rtk docker ps` (compact table)
- `kubectl get pods` → `rtk kubectl get pods` (compact table)
- `ps aux` → `rtk ps aux` (hides kernel threads)
- `lsof -i` → `rtk lsof -i` (compact columns)
- `ls -la` → `rtk ls -la` (hides `.`/`..`, compact timestamps)

See [rtk-ai/rtk#command-registry](https://github.com/rtk-ai/rtk) for full list.

### Fail-open behavior

| Scenario | Behavior |
|----------|----------|
| rtk binary not in PATH | Console warning at load time, extension disabled |
| rtk < 0.23.0 | Console warning at load time, extension disabled |
| `rtk rewrite` returns error | Pass-through — original command unchanged |
| `rtk rewrite` times out | Pass-through (2s timeout) |
| Extension throws | Pass-through, console warning |
| `RTK_DISABLED=1` set | Extension loaded but skips all rewrites |
| Command starts with `rtk ` | Skipped — prevents recursion |

### No conflict with other extensions

RTK only touches `tool_call` → `bash` → `event.input.command`. Extensions that also register `tool_call`:

| Extension | Interaction |
|-----------|------------|
| worktree-sandbox | Prepends `cd /sandbox && ` after RTK rewrite — safe order: RTK first, sandbox wraps |
| agent-harness | Validates tool calls, blocks grep/rg/cat/head/tail — RTK-rewritten commands (prefix `rtk`) bypass the filter |
| piignore | Only checks `read`/`write`, ignores bash |
| session-logger | Read-only observer |

### Analytics

```bash
rtk gain --history
```

Shows per-command token savings. Data stored in `~/.local/share/rtk/`. Reset with `rtk gain --reset`.

### Updating the extension

The extension file is a one-time copy from RTK upstream. Check for changes:

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/develop/hooks/pi/rtk.ts \
  | diff - .pi/extensions/rtk/index.ts
```

Overwrite if changed:

```bash
curl -fsSL -o .pi/extensions/rtk/index.ts \
  https://raw.githubusercontent.com/rtk-ai/rtk/develop/hooks/pi/rtk.ts
```

The binary is updated independently — new rewrite rules land in the Rust binary, not the extension.
