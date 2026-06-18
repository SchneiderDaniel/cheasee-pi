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

**How it works.** Loads `.piignore` files walking up from project root to filesystem root (hierarchical loading). On every tool call, checks target paths against loaded patterns. Bash commands tokenized with shell-aware parsing — URLs, npm scoped packages, echo/printf strings are excluded from path checking. Pattern reload on `/reload` via `resources_discover` event. Shows warning toast when a path is blocked (TUI/RPC modes with UI). Global companion extension warns about overly broad patterns (`*`, `**/*secret*`) before trust is granted.

**Location:** `.pi/extensions/piignore/`
