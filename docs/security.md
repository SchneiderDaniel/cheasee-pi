---
layout: default
title: Security
nav_order: 5
---

# Security

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Design philosophy: no MCP servers

Cheasee-Pi deliberately avoids the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). All tools are **pi extensions** — TypeScript files in `.pi/extensions/` that run inside the agent's Node.js runtime. No external MCP servers, no network-exposed tool endpoints, no separate processes.

**Why:** MCP servers introduce network attack surface. The OWASP project maintains an [MCP Top 10](https://owasp.org/www-project-mcp-top-10/) covering threats like prompt injection via tool descriptions, server spoofing, and unauthorized resource access. Extensions treat tool execution as a function call — no network layer means no network attack surface.

All tools run locally. Web crawling runs on the host (network access only for the crawl itself). ast-grep, ripgrep are system binaries invoked via `pi.exec()`. Code never leaves your machine except LLM API calls to your configured provider.

## Agent Harness — runtime tool call validation

The Agent Harness extension intercepts every tool call before execution and validates it against a set of rules:

- **Tool mismatch prevention** — `bash | grep` / `bash | rg` is blocked and redirected to `ripgrep_search`. `bash cat` / `head` / `tail` is blocked and redirected to `read`
- **Error loop prevention** — After 2 consecutive errors on the same tool, further calls are blocked with a suggestion to try a different approach
- **Cascade prevention** — 8+ consecutive calls to the same tool (e.g., 8 `bash` calls in a row) trigger a block with a batching suggestion
- **Read caching** — Re-reading the same file within 6 turns returns cached content instead of re-executing, preventing redundant I/O

Rules are configurable via `.pi/harness-config.json` with per-tool thresholds. Loaded per session; `/reload` picks up changes.

## PiIgnore — path blocking

The `.piignore` file blocks agent access to sensitive paths using gitignore-style patterns. Intercepts `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` when a target path matches.

**Dual trust model:**
- **Trusted project** — `.piignore` patterns are loaded and enforced as written, walking up from project root to filesystem root (hierarchical loading)
- **Untrusted project** — `.piignore` patterns are **not honored**. Instead, a hardcoded safe-default block list is enforced: `*.env`, `.env.*`, `secrets/`, `**/*.pem`, `**/*.key`. This prevents an attacker who controls the repository from using `.piignore` to open paths or selectively block access

**Shell-aware parsing:** Bash commands are tokenized before path checking — URLs, npm scoped packages, echo/printf strings are excluded from file-path matching. Commands chained after `&&`, `||`, `;`, or `|` are checked independently.

## Worktree Sandbox — isolation enforcement

When the supervisor pipeline runs Developer and Auditor agents, each gets its own git worktree. The Worktree Sandbox enforces that agents operate ONLY within their assigned worktree:

- **`read`/`write`/`edit`** — Relative paths get the worktree root prepended. Absolute paths are checked — blocked if outside worktree
- **`bash`** — Prepends `cd "<worktree>" && ` to every command
- **`cd` escape prevention** — Shell-aware parsing via `shell-quote` detects variable expansion (`$HOME` → blocked as `<HOME>`), tilde expansion (`~/escape` → blocked), command substitution (`$(...)` → blocked), pipe prefix bypasses (`echo \| cd /escape` → blocked)
- **File write prevention** — Shell redirects (`>`, `>>`), `cp`/`mv`/`touch` destinations outside worktree are blocked

**Trust gate:** Before resolving `WORKTREE_SANDBOX_PATH`, the extension checks `ctx.isProjectTrusted()`. Untrusted projects skip sandbox entirely — prevents attacker-controlled environment variables from redirecting sandbox operations.

## Project trust gates

Multiple extensions use pi's `ctx.isProjectTrusted()` mechanism to gate sensitive operations:

| Extension | What's gated | Behavior when untrusted |
|-----------|-------------|------------------------|
| PiIgnore | `.piignore` file loading | Uses hardcoded safe-defaults instead |
| Worktree Sandbox | Sandbox enforcement | Skipped entirely |
| LSP Auditor | LSP diagnostics | Returns `{ proceed: true }` with warning |
| Format on Save | Prettier + ESLint | No formatting or linting |
| TSC Checkpoint | TypeScript compiler | Skipped with message |
| Session Logger | Report generation | No reports written |
| Session Advice | Advice generation + lesson injection | Disabled |
| Check Extensions | Extension audit | Disabled |
| Ask User | Q&A history persistence | History not written to disk |

The trust mechanism prevents untrusted (e.g., freshly cloned) repositories from running attacker-controlled configurations that could weaponize LSP servers, formatter configs, tsconfig paths, or `.piignore` patterns.

## API key management

- API keys are stored in `.agent_env` (sourced from `docker/agent_env.example`)
- `.agent_env` is listed in `.gitignore` — never committed to the repository
- The file is mounted into the Docker container at runtime, not baked into the image
- Each LLM provider key is loaded as an environment variable inside the container

## Docker security

- **Base image:** Debian 12-slim (minimal attack surface)
- **UID/GID mapping:** Host user's UID/GID is mapped to container user `agentuser` via `gosu` — prevents permission escalation on bind-mounted files
- **Rootless:** The container runs as `agentuser`, not root
- **Bind mount only:** The repo root is mounted read-write; no privileged mounts
- **No exposed ports:** The container has no network-exposed services

## npm package age gate

The supervisor pipeline enforces a **14-day minimum age** for any package installed from the public npm registry:

```bash
npm view <pkg> time.created
```

- If the package is < 14 days old, installation is blocked with: "Package [name] is [X] days old — below 14-day safety threshold. Cannot install."
- This rule does not apply to git URLs, tarballs, or local paths

This prevents supply chain attacks via recently published malicious packages.

## Scope boundary enforcement

Before dispatching the Developer agent, the supervisor runs a `git diff` check against the GitHub issue labels to determine which files the agent is allowed to modify. Agents are restricted from writing to files outside their assigned scope.

## Additional security properties

- **No code telemetry:** All components run locally. No usage data, session content, or code is sent anywhere except LLM API calls
- **Session advice audit trail:** All tool calls are logged to `.pi/sessions/` — providing a full audit trail of every operation
- **Controlled network access:** Only the `web_crawl` and `web_search` extensions make outbound HTTP requests
- **Sandboxed Python venvs:** Python dependencies for web crawl and web search are installed in isolated virtual environments (`.pi/scrapling-venv/`, `.pi/web-search-venv/`), not system-wide
