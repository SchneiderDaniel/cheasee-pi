---
layout: default
title: Ponytail
parent: Extensions
nav_order: 18
---

# Ponytail

{: .no_toc }

[📦 GitHub](https://github.com/DietrichGebert/ponytail)

**Why.** Prevents over-engineering by injecting lazy senior dev rules into every session. Saves code, dependencies, and complexity. YAGNI, stdlib-first, one-line ladder.

**How it works.** Installed as a project package via `packages` in `.pi/settings.json`. Cloned to `.pi/git/github.com/DietrichGebert/ponytail/`. Symlinked into `.pi/extensions/ponytail/` for pi auto-discovery and supervisor sub-agent resolution. Hooks `before_agent_start` to inject rules into system prompt. Registers `/ponytail` commands and skill aliases (`/ponytail-review`, `/ponytail-audit`, etc.).

**Location:** `.pi/extensions/ponytail/` (symlink to `.pi/git/github.com/DietrichGebert/ponytail/pi-extension/`)

## Why use it

Agents default to over-building — interfaces before they're needed, factories for one product, dependencies for what stdlib covers. Ponytail counteracts this by embedding a decision ladder into the agent's reasoning:

1. Does this need to exist at all? (YAGNI)
2. Does stdlib do it? Use it.
3. Does native platform cover it? Use it.
4. Does an installed dependency solve it? Use it.
5. Can it be one line? One line.
6. Only then: minimum code.

## Commands

| Command | Effect |
|---------|--------|
| `/ponytail` or `/ponytail full` | Full ladder enforced. Default |
| `/ponytail lite` | Build what's asked, name lazier alt |
| `/ponytail ultra` | YAGNI extremist |
| `/ponytail off` | Disable ponytail for session |
| `/ponytail status` | Show current + default mode |
| `/ponytail review` | Run ponytail-review skill |
| `/ponytail-audit` | Whole-repo bloat scan |

Deactivate with `stop ponytail` or `normal mode`. Resume with `/ponytail`.

## Skills

Ponytail ships 6 skills for manual invocation:

| Skill | Trigger | Purpose |
|-------|---------|---------|
| ponytail | `/skill:ponytail` | Lazy mode instructions |
| ponytail-review | `/skill:ponytail-review` | Diff-level over-engineering review |
| ponytail-audit | `/skill:ponytail-audit` | Whole-repo bloat scan |
| ponytail-debt | `/skill:ponytail-debt` | Track deliberate shortcuts |
| ponytail-gain | `/skill:ponytail-gain` | Measured-impact scoreboard |
| ponytail-help | `/skill:ponytail-help` | Reference card |

## Agent integration

Ponytail is active for the main interactive session by default. Supervisor sub-agents only get ponytail when listed in their frontmatter `extensions:` field:

- **developer** — `ponytail` in extensions (YAGNI during implementation)
- **auditor** — `ponytail` in extensions (over-engineering review mindset)

Architect, researcher, and test-designer do not include ponytail — their roles conflict with lazy-mode thinking.

## Details

### Architecture

```
package ponytail (cloned to .pi/git/github.com/DietrichGebert/ponytail/)
├── pi-extension/
│   └── index.js          # Extension entry: hooks + commands
├── hooks/
│   ├── ponytail-config.js        # Mode resolution, persistence
│   └── ponytail-instructions.js  # Prompt generation from SKILL.md
└── skills/
    ├── ponytail/                 # Lazy mode skill
    ├── ponytail-review/          # Over-engineering review skill
    ├── ponytail-audit/           # Whole-repo audit skill
    ├── ponytail-debt/            # Shortcut ledger skill
    ├── ponytail-gain/            # Impact scoreboard skill
    └── ponytail-help/            # Reference card skill
```

### Prompt Injection

Via `before_agent_start` hook. Reads `skills/ponytail/SKILL.md` from the cloned repo, filters by current intensity level (lite/full/ultra), appends to system prompt. No injection when mode is `off`.

### Mode Persistence

Mode is persisted to session entries (`ponytail-mode` custom entry). Survives session restarts. Default defined by config file or env var `PONYTAIL_DEFAULT_MODE`.

### Deactivation Monitoring

The `input` hook watches for deactivation phrases (`stop ponytail`, `normal mode`) and switches to `off` automatically.
