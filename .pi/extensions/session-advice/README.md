# Session Advice

**Post-session analysis that teaches your agent to waste fewer tokens.** After every session, Session Advice analyzes the JSONL log, detects wasteful patterns, and generates `.advice.md` with fix recommendations. Past lessons are automatically injected into the next session's system prompt.

## Why

The biggest source of token waste is invisible — the LLM doesn't realize it's using the wrong tool, re-reading the same file, or getting stuck in error loops. Session Advice makes waste visible:

- **Tool mismatch detection** — `bash | grep` instead of `ripgrep_search` (costs 5-10x more tokens)
- **Error loops** — Same tool errored 4x without changing approach
- **Identical call loops** — Same tool+args repeated 3x in last 12 calls
- **Redundant reads** — Same file read within 2 turns
- **Same-tool cascades** — 12 consecutive `bash` calls without batching
- **Structural-search underuse** — 3+ code files read but `structural_search` never called
- **Excessive turns** — 20+ tool calls with no file changes (agent is stuck planning)

Detected patterns are ranked by severity (error/warning), aggregated into `latest.advice.md`, and the top 3 actionable items are injected into the LLM's system prompt for the next session. Over time, the agent learns to avoid its worst patterns.

## How it works

1. **Session shutdown** — When a session closes, the extension reads its `.jsonl` file
2. **Signal detection** — Runs 10+ waste signal detectors against the session data:
   - `bash-grep.ts` — Detects `bash | grep/rg` instead of `ripgrep_search`
   - `bash-cat.ts` — Detects `bash cat/head/tail` instead of `read`
   - `error-loop.ts` — Tracks consecutive errors without approach change
   - `identical-args.ts` — Same tool + identical args repeated
   - `redundant-reads.ts` — Same file path read within 2 turns
   - `structural-underuse.ts` — Code reading without AST search
   - `no-batch.ts` — Consecutive same-tool calls not batched
   - `turn-inefficiency.ts` — High turn count with no file changes
3. **Advice generation** — Waste signals are formatted into `latest.advice.md` with severity labels, concrete examples, and fix recommendations
4. **Backfill** — On session start, checks for past sessions missing `.advice.md` and generates them
5. **Lesson injection** — On next session's `before_agent_start`, reads `latest.advice.md`, extracts top 3 actionable items, and appends them to the system prompt

### Report generation

`/session-advice report` generates a comprehensive waste report across all sessions:
- Aggregated waste percentage
- Pattern frequency histogram
- Detector improvement suggestions (LLM-reviewed signal proposals)
- Option to create GitHub issue from report

### Command

| Command | Effect |
|---------|--------|
| `/session-advice` | Toggle on/off |
| `/session-advice on` | Enable for next session |
| `/session-advice off` | Disable |
| `/session-advice report` | Generate aggregate waste report |

## Install

Part of Cheasee-Pi monorepo. Activated automatically.

## Requirements

- Pi Coding Agent ≥ 0.79.1
- Session Logger must be enabled (generates the `.jsonl` files that Session Advice analyzes)

## License

MIT
