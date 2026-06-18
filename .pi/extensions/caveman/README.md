# Caveman Protocol

**Token-efficient AI communication.** Compresses all agent output — strips articles, filler words, pleasantries and hedging — while preserving technical accuracy. Configurable intensity.

## Why

Every response turn costs tokens. Caveman reduces response token count by roughly 30-50% by dropping unnecessary words. Active every session via `AGENTS.md`.

**What it cuts:**
- Articles (a/an/the), filler (just/really/basically/actually/simply)
- Pleasantries (sure/certainly/of course/happy to)
- Hedging (I think/perhaps/maybe/kind of)
- Verbose phrasing ("implement a solution for" → "fix")

Technical terms stay exact. Code blocks unchanged. Errors quoted exact.

## How it works

1. **Config load** — Reads `~/.pi/agent/caveman.json` at session start (or defaults)
2. **Session resolution** — Checks `AGENTS.md` for `{"caveman": "level"}` entry, falls back to config default
3. **Level persistence** — Stored in session entries, survives reload
4. **Mode adaption** — In `json`/`rpc` modes, compression is skipped entirely to avoid mangling structured output
5. **Prompt injection** — `before_agent_start` appends caveman rules to system prompt
6. **Lightening** — If `ripgrep_search`/`structural_search` are active, compression lightens to preserve structured tool output

### Levels

| Level | Effect | Example |
|-------|--------|---------|
| **lite** | Professional, tight. Drop filler only. Full sentences. | "Your component re-renders because you create a new object reference each render. Wrap it in `useMemo`." |
| **full** | Fragments. Drop articles. Short synonyms. | "Bug in auth middleware. Token expiry check uses `<` not `<=`. Fix:" |
| **off** | No compression. Standard verbose style. | |

Cycle with `/caveman` command: lite → full → off → lite.

### Auto-clarity (full level)

Full caveman auto-disables for:
- Security warnings
- Irreversible action confirmations
- Multi-step sequences where fragment clarity risks misread
- User asks to clarify

## Install

Part of Cheasee-Pi monorepo. Activated automatically.

## Requirements

- Pi Coding Agent ≥ 0.78.0
- `AGENTS.md` in project root (activates protocol per session)

## License

MIT
