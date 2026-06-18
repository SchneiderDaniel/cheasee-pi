---
layout: home
title: Overview
nav_order: 1
---

# Cheasee-Pi: Build Your Own PI. Cheap. Easy. Secure.

{: .fs-9 }

Token-saving agent harness with security guardrails and a Kanban git-oriented sub-agent framework. Docker + Pi AI — autonomous Kanban pipeline, sandboxed execution, real-time feedback via git worktrees for parallel development.

{: .fs-6 .fw-300 }

[Get started](installation){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/SchneiderDaniel/cheasee-pi){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## What is Cheasee-Pi?

Cheasee-Pi is a **Pi agent harness** built on the [Pi coding agent](https://pi.dev) — engineered to save tokens, enforce security boundaries, and drive sub-agents through a Kanban git-oriented workflow. It uses a GitHub Project board to orchestrate an autonomous multi-agent pipeline — Researcher → Architect → TestDesigner → Developer → Auditor — with tools that minimise token waste, enforce security boundaries, and streamline development inside isolated git worktrees.

### Key features

- **Structural search** — `structural_search` via ast-grep: AST-aware pattern matching
- **Text search** — `ripgrep_search` via ripgrep: fast literal/regex code search
- **Web crawling** — `web_crawl`: Scrapling with automatic Cloudflare bypass
- **Rich TUI** — Custom status bar, welcome banner, animated indicators
- **Session logging** — Every conversation saved as JSONL
- **Multi-agent pipeline** — Autonomous Kanban: Researcher → Architect → TestDesigner → Developer → Auditor
- **LSP pre-audit** — Real LSP diagnostics before merge, auto-retry on errors
- **TypeScript checkpoint** — `/check` command: `tsc --noEmit` on demand
- **PiIgnore** — Block paths from agent read/write/edit/bash
- **Extensions-based** — 12+ secure pi extensions, no MCP servers, no network-exposed endpoints
- **Custom theme** — Dark cyberpunk TUI (cheasee-pi)

All components run locally. No code leaves your machine (except LLM API calls to your provider).

## Philosophy

Everyone should build their own Pi. This repo is **my personal** Pi agent harness. Fork it as a starting point, but the real power comes from shaping it into **your own**.

Why? Every developer and every team is different. The most effective way of working with an AI coding harness is the one that fits **your** workflow, not a one-size-fits-all maximalist suite.

Customize ruthlessly. Make it yours.

## Project structure

```
.
├── .pi/                      # Pi configuration, extensions, themes, prompts
│   ├── extensions/           # 12+ pi extensions (tools)
│   ├── themes/               # TUI color themes
│   ├── prompts/              # Prompt templates
│   ├── skills/               # Skill definitions
│   └── settings.json         # Supervisor + TUI config
├── docker/                   # Docker build files
├── docs/                     # Documentation site
├── scripts/                  # Utility scripts
├── test/                     # Tests
├── AGENTS.md                 # Always-on system prompt (caveman protocol)
├── Makefile                  # Docker workflow commands
└── cheasee-pi.sh             # Entry-point wrapper script
```

## Quick start

```bash
git clone git@github.com:SchneiderDaniel/cheasee-pi.git
cd cheasee-pi
cp docker/agent_env.example .agent_env  # Edit with your API keys
./cheasee-pi.sh                         # Build & launch
```

See [Installation](installation) for detailed setup.

## Verification

After launching, verify everything works:

```bash
pi "Respond with exactly one word: 'Operational'."
```

Expected output: `Operational`

## License

Distributed under the [MIT License](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/LICENSE).
