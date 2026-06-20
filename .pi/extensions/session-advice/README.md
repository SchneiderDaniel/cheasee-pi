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

## Details

### Architecture

Waste signal detection + LLM-based advice generation:

```
├── index.ts           # Entry: /session-advice command, lifecycle hooks, lesson injection
├── session-analyzer.ts # Pure waste signal detectors (10+ patterns)
├── llm-advisor.ts     # LLM-based advice generation from detected signals
├── advice-pipeline.ts # Orchestrator: analyze, generate, write, symlink
├── symlink-manager.ts # latest.advice.md symlink management
└── test/              # Unit tests for all detectors
```

### Waste Detectors

```mermaid
flowchart LR
    A[.jsonl file] --> B[analyzeSession: 10+ detectors]
    B --> C[Tool mismatch: bash|grep vs ripgrep_search]
    B --> D[Error loop: 2+ consecutive same-tool errors]
    B --> E[Identical call loop: same tool+args 3x in 12 calls]
    B --> F[Same-tool cascade: 8+ consecutive same tool]
    B --> G[Tool coverage gap: code files but no structural_search]
    B --> H[Structural underuse: 3+ code files read, no AST search]
    B --> I[Redundant reads: same file within 2 turns]
    B --> J[Excessive turns: 20+ calls, no file changes]
    B --> K[No batch: consecutive same-tool not merged]
    B --> L[Turn inefficiency: 20+ calls per turn, no saves]
    C --> M[Generate .advice.md with severity]
    D --> M
    E --> M
    F --> M
    G --> M
    H --> M
    I --> M
    J --> M
    K --> M
    L --> M
    M --> N[before_agent_start: inject top 3 lessons]
```

### Detector Details

| Pattern | Severity | Detection Logic |
|---------|----------|-----------------|
| Tool mismatch | error | `bash | grep` instead of `ripgrep_search` |
| Error loop | error | 2+ consecutive tool errors, same tool, no action |
| Identical call loop | error | Same tool+args 3x in last 12 calls |
| Same-tool cascade | warning | 8+ consecutive same-tool calls |
| Tool coverage gap | warning | Code files present but `structural_search` unused |
| Structural underuse | warning | 3+ code files read, no AST search |
| Redundant reads | warning | Same file within 2 turns |
| Excessive turns | warning | 20+ calls, zero file changes |
| No batch | warning | Consecutive same-tool not merged |
| Turn inefficiency | warning | 20+ calls per turn, no saves |

### Key Design Decisions

- **Dual analysis** — Pure function `analyzeSession()` parses JSONL for signals. LLM enriches with recommendations.
- **Top-3 lesson injection** — Extracts first 3 actions from `latest.advice.md`, appends to system prompt on `before_agent_start`.
- **Clean session detection** — If advice says "Clean session", no lessons injected.
- **Signal review lifecycle** — `/session-advice report` proposes detector removals/additions, creates GitHub issues.
- **Session cleanup** — Report command offers to delete all session files except `advice-report.md` and latest symlinks.
- **Cross-reference with systemPromptOptions** — If >12 tools configured but few used, suggests pruning.
- **State persistence** — Enabled/disabled in `.pi/state/session-extensions.json`.

### Advice File Format

```
# Session Advice -- <session_id>

**Total waste percentage:** 15.3%
**Wasted tokens:** ~12,450

## Waste Signals
| Signal | Severity | Count | Tokens Wasted |

## Recommended Actions
- RED **Use structural_search instead of read**
- YELLOW **Batch same-tool calls with &&**
- GREEN **Set max_count on ripgrep_search**
```

### System Prompt Injection

```
⚠️ Past Session Lessons (from session advisor)
  - Use structural_search instead of read for code patterns
  - Batch same-tool calls with &&
  - Set max_count on ripgrep_search
```

## License

MIT
