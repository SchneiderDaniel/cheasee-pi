---
layout: default
title: Security
nav_order: 9
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

The [Agent Harness](extensions/agent-harness) extension intercepts every tool call and enforces guards that prevent security-relevant tool misuse:

- **Tool mismatch prevention** — `bash | grep` / `bash cat` is blocked, agent redirected to `ripgrep_search` / `read`
- **Error loop prevention** — After 2 consecutive errors, further calls to same tool are blocked
- **Cascade prevention** — 8+ consecutive same-tool calls trigger a block with batching suggestion
- **Read caching** — Re-reading the same path+offset+limit within 6 turns (or 30 s) is blocked with a hint in TUI mode (non-TUI passes through), preventing redundant I/O; the cache stores an existence marker only — it does not return cached bytes

Rules are configurable via `.pi/harness-config.json`.

## Worktree Sandbox — isolation enforcement

The [Worktree Sandbox](extensions/worktree-sandbox) extension enforces that pipeline agents operate ONLY within their assigned git worktree:

- **`read`/`write`/`edit`** — Relative paths rewritten to worktree root; absolute paths outside worktree are blocked
- **`bash`** — Prepends `cd "<worktree>" && ` to every command
- **`cd` escape prevention** — Shell-aware parsing detects variable expansion, tilde expansion, command substitution, pipe prefix bypasses
- **File write prevention** — Shell redirects, `cp`/`mv`/`touch` destinations outside worktree are blocked

**Trust gate:** Before resolving the sandbox path, `ctx.isProjectTrusted()` is checked. Untrusted projects skip sandbox entirely — prevents attacker-controlled environment variables from redirecting sandbox operations.

## Project trust gates

Multiple extensions use pi's `ctx.isProjectTrusted()` mechanism to gate sensitive operations:

| Extension | What's gated | Behavior when untrusted |
|-----------|-------------|------------------------|
| Worktree Sandbox | Sandbox enforcement | Skipped entirely |
| LSP Auditor | LSP diagnostics | Returns `{ proceed: true }` with warning |
| Format on Save | Prettier + ESLint | No formatting or linting |
| TSC Checkpoint | TypeScript compiler | Skipped with message |
| Session Logger | Report generation | No reports written |
| Check Extensions | Extension audit | Disabled (internal) |
| Ask User | Q&A history persistence | History not written to disk |
| Supervisor CI gating | GitHub check run polling | CI gate skipped (branch may not exist) |
| Supervisor dead-code gate | knip execution | Dead code check skipped |
| Supervisor duplicate-code gate | jscpd execution | Duplicate code check skipped |

The trust mechanism prevents untrusted (e.g., freshly cloned) repositories from running attacker-controlled configurations that could weaponize LSP servers, formatter configs, or tsconfig paths.

## Docker security

- **Base image:** Debian 12-slim (minimal attack surface)
- **UID/GID mapping:** Host user's UID/GID is mapped to container user `agentuser` via `gosu` — prevents permission escalation on bind-mounted files
- **Rootless:** The container runs as `agentuser`, not root
- **Bind mount only:** The repo root is mounted read-write; no privileged mounts
- **Published ports bound to loopback:** The `cheasee-pi` agent container has no network-exposed services. The `ui` sidecar (web control center) publishes one host port, bound to IPv4 loopback (`127.0.0.1:<port>`) by the compose mapping — the explicit `127.0.0.1` prefix pins it, not Docker's default (which listens on all interfaces). This is loopback-bound configuration, not a hard isolation boundary: Docker Engine before 28.0.0 may expose a loopback-published port to hosts on the same L2 segment, and the supported floor is Engine 24.0.0. Loopback is the default and the only supported mode; non-localhost exposure and the pre-28 caveat are tracked for hardening in the compose-harness work (#1527).

## UI sidecar network posture

The `ui` sidecar (web control center) is the only component that publishes a
host port. Its host bind is set to `127.0.0.1` in the compose mapping, so it is
loopback-bound by configuration; non-localhost exposure is deliberately
deferred to the compose-harness hardening work (#1527).

Loopback-bound is a configuration guarantee, not a hard isolation boundary.
Docker Engine before 28.0.0 may expose a loopback-published port to hosts on the
same L2 segment, and this project accepts Engine 24.0.0 and later, so on those
engines the port is not guaranteed to be unreachable off-host. Treat the control
center as if it could be reached from the local network until #1527 hardens the
mapping.

Loopback is a **reachability pin, not an authorization boundary**. The control
center performs no authentication, and the loopback pin is the only control on
its surface, which includes:

- the WebSocket RPC relay on `/ws` — the handshake is not constrained by the
  browser same-origin policy, so without `Origin` validation a malicious page
  could open a two-way channel to the loopback server (cross-site WebSocket
  hijacking);
- an unauthenticated `GET /debug/child` endpoint returning the child PID,
  session id, auth source, and provider env-var *names*;
- the absence of `Host`-header allow-listing, which leaves DNS-rebinding attacks
  (a page resolving its own origin to `127.0.0.1`) viable against the HTTP
  surface.

Any other local process or user on the same host can also reach the port. Treat
the control center as trusted-local-only until #1527 lands.

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
