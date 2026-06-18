---
layout: default
title: PiIgnore
parent: Extensions
nav_order: 14
---

# PiIgnore

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/piignore/README.md) — [`@cheasee-pi/piignore` on npm](https://www.npmjs.com/package/@cheasee-pi/piignore)

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
