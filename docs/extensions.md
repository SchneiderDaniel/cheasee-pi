---
layout: default
title: Extensions
nav_order: 7
has_children: true
---

# Extensions

{: .no_toc }

Pi auto-discovers extensions from `.pi/extensions/` in the project root. No config file needed. No `--extension` flag.

This page lists all 19 extensions in the Cheasee-Pi monorepo. Each has its own page with **Why** (benefit) and **How** (walkthrough).

## File manifest

| File/Path | Extension |
|-----------|-----------|
| `.pi/extensions/structural-analyzer/` | [Structural Analyzer](extensions/structural-analyzer) |
| `.pi/extensions/ripgrep-search/` | [Ripgrep Search](extensions/ripgrep-search) |
| `.pi/extensions/scrapling/` | [Web Crawl (scrapling)](extensions/scrapling) |
| `.pi/extensions/web-search/` | [Web Search](extensions/web-search) |
| `.pi/extensions/supervisor/` | [Supervisor](extensions/supervisor) |
| `.pi/extensions/context-info/` | [Context Info](extensions/context-info) |
| `.pi/extensions/session-logger/` | [Session Logger](extensions/session-logger) |
| `.pi/extensions/session-advice/` | [Session Advice](extensions/session-advice) |
| `.pi/extensions/agent-harness/` | [Agent Harness](extensions/agent-harness) |
| `.pi/extensions/ask-user/` | [Ask User](extensions/ask-user) |
| `.pi/extensions/caveman/` | [Caveman Protocol](extensions/caveman) |
| `.pi/extensions/format-on-save/` | [Format on Save](extensions/format-on-save) |
| `.pi/extensions/lsp-auditor/` | [LSP Auditor](extensions/lsp-auditor) |
| `.pi/extensions/ponytail/` | [Ponytail](extensions/ponytail) |
| `.pi/extensions/piignore/` | [PiIgnore](extensions/piignore) |
| `.pi/extensions/tsc-checkpoint/` | [TSC Checkpoint](extensions/tsc-checkpoint) |
| `.pi/extensions/check-extensions/` | [Check Extensions](extensions/check-extensions) |
| `.pi/extensions/worktree-sandbox/` | [Worktree Sandbox](extensions/worktree-sandbox) |
| `.pi/extensions/rtk/` | [RTK](extensions/rtk) |
| `.pi/extensions/lib/` | Shared library (not an extension) — `extension-state.ts`, `bash-query.ts`, `ensureVenv.ts` |

## Published packages

Selected extensions are published as npm packages under the `@cheasee-pi` scope.

| Package | Extension | Install |
|---------|-----------|--------|
| `@cheasee-pi/ask-user` | [Ask User](extensions/ask-user) | `pi install npm:@cheasee-pi/ask-user` |
| `@cheasee-pi/ripgrep-search` | [Ripgrep Search](extensions/ripgrep-search) | `pi install npm:@cheasee-pi/ripgrep-search` |
| `@cheasee-pi/lsp-auditor` | [LSP Auditor](extensions/lsp-auditor) | `pi install npm:@cheasee-pi/lsp-auditor` |
| `@cheasee-pi/piignore` | [PiIgnore](extensions/piignore) | `pi install npm:@cheasee-pi/piignore` |
| `@cheasee-pi/structural-analyzer` | [Structural Analyzer](extensions/structural-analyzer) | `pi install npm:@cheasee-pi/structural-analyzer` |

**Why publish separately?** Not all extensions belong on pi.dev — some are Cheasee-Pi-specific (supervisor, session-logger, context-info). Published packages are self-contained, useful in any Pi setup.

**Package structure:** Each published extension has its own `package.json` with `keywords: ["pi-package"]` and a `pi` manifest pointing to its entry file.

Use `/package-extension` in Pi's editor to package an extension for npm — see [Prompts](prompts) for details.
