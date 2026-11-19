# Goal Loop

Verified goal mode for repository tasks. A goal starts only after it is measurable, reachable and verifiable. The loop then works in an isolated worktree, keeps its state in an ignored Markdown record, publishes a draft pull request, and resumes from that record in a fresh Pi session at each configured context checkpoint.

## Why

Long coding tasks that continue through ordinary prompting lose their intent in two predictable places: the goal itself is ambiguous, and the conversation that carries it is eventually compacted. The extension addresses both. Clarification is a gate, completion is an evidence verdict rather than a model claim, and the durable state lives on disk in a file the agent never writes.

## Commands

| Command                   | Effect                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/goal <description>`     | Creates a `clarifying` record and asks the agent to restate the goal with verifiable acceptance criteria. |
| `/goal status`            | Reports status, completed iterations, context resets, per-criterion results, worktree, branch and PR.     |
| `/goal stop`              | Aborts the running generation, saves the final status and creates nothing further.                        |
| `/goal resume --approve`  | Continues a paused goal after explicit approval.                                                          |
| `/goal revise`            | Returns the goal to clarification; criteria change only through a resubmitted clarification.              |
| `/goal cleanup --confirm` | Removes the goal worktree. The worktree and branch are otherwise retained, including after a merged PR.   |

## Configuration

The model and the loop limits are project settings under `goalLoop` in `.pi/settings.json`. The configured model is authoritative for clarification, implementation and verification; there is no fallback to the interactive session model.

```json
{
	"goalLoop": {
		"model": "provider/model-id",
		"contextRolloverTokens": 150000,
		"maxIterations": 50
	}
}
```

`contextRolloverTokens` and `maxIterations` are positive integers with defaults of `150000` and `50`. The capacity gate refuses to start when the configured model's context window cannot hold the rollover threshold plus Pi's response reserve (`compaction.reserveTokens`, default `16384`). A missing, malformed or unresolvable model refuses goal execution.

## State

One record per goal is written to `<original checkout>/ignore/goals/<yyyymmdd-hhmmss>-<slug>-<rand4>.md`. The directory is already excluded by `.gitignore`, so the record cannot enter the pull request. The front matter is the machine-read part; the loop writes it through a temporary file and an atomic rename, and the agent never edits the file itself.

The record carries the request, the clarified goal, the acceptance criteria and their verification methods, the evidence of the last verification pass, the status, the completed iteration count, the context reset count, the last checkpoint, the next action, the effective configuration, the worktree, the branch, the pull request reference and any blocking error.

## Loop behaviour

- **Clarification gate.** An unclear, unreachable or unverifiable goal stays `clarifying` and returns at most five focused questions. `/goal stop` during clarification cancels the record and creates no worktree or branch.
- **Isolation.** A clean checkout is required. The worktree and branch are created from the original checkout's `HEAD`; a dirty or detached checkout is refused and left untouched. All goal changes happen in that worktree, and a draft pull request is opened after the first goal commit.
- **Verification.** Every criterion is re-checked from scratch at each boundary. `command` verifiers run as an argv array in the worktree after every pinned hash is confirmed; `inspect` verifiers judge harness-produced evidence only. Stored evidence never satisfies the gate.
- **Completion.** The goal completes only when every criterion passes and the pull request exists. The pull request is then marked ready for review through the GraphQL mutation, because the REST API silently ignores `draft: false`. The loop never merges.
- **Rollover.** At the configured threshold the loop verifies completion first. An incomplete goal is checkpointed and resumed through a new agent session in the same worktree, from the record alone. Iteration and reset counts stay cumulative, and an observed in-place compaction forces a rollover at the next boundary.

## Architecture

```
├── index.ts                     # /goal registration, steering input, settle boundary, session_compact
├── commands.ts                  # argument parsing and command dispatch
├── tools.ts                     # goal_submit_clarification, goal_report_iteration
├── backend.ts                   # production wiring for one session
├── lazy-pull-request.ts         # GitHub port resolved on first use
├── inspect-verdict.ts           # nested inspect verifier over harness evidence
├── domain/                      # record entity, ids, Markdown mapping, criteria, steering, boundary policy
├── application/                 # GoalService facade, start, clarification, boundary, publication, control
├── adapters/                    # Markdown store, git workspace, GitHub PR, Pi runtime, verification runner
├── config/                      # goalLoop schema, model resolution, capacity gate
└── test/                        # entity, use-case, adapter and user-journey suites
```

Shared primitives live in `.pi/extensions/shared/`: the git worktree and query helpers, the pull-request create-or-update sequence, the model-reference resolver and the worktree removal guard. The Supervisor uses the same modules, so both consumers issue identical git and GitHub operations.

## Testing

```bash
node --experimental-strip-types --test \
  '.pi/extensions/goal-loop/test/*.test.mts' \
  '.pi/extensions/shared/test/*.test.mts'
```

The suites cover configuration validation and model resolution, the clarification gate, state persistence and fail-closed parsing, worktree and pull-request failures, steering, verified completion, the configured iteration limit and repeated context rollovers.
