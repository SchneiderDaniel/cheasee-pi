---
layout: default
title: Goal Loop
parent: Extensions
nav_order: 21
---

# Goal Loop

{: .no_toc }

[📄 README](../../.pi/extensions/goal-loop/README.md)

**Why.** Sustained work on a coding task fails in two places. An ambiguous request starts work that cannot be verified, and a long conversation is eventually compacted, which loses the intent that the work is serving. Goal mode addresses both: the goal starts only after it is measurable, reachable and verifiable, and its durable state lives in an ignored Markdown record that a fresh session resumes from.

**How it works.** `/goal <description>` writes a `clarifying` record and asks the agent to restate the goal with verifiable acceptance criteria. The agent submits them through `goal_submit_clarification`; the loop validates every criterion, and a ready goal activates without a further confirmation step. Work then runs in a dedicated worktree created from the original checkout's `HEAD`, on a branch of its own. Each settle boundary checkpoints the iteration, re-runs every verifier, publishes a draft pull request once a work iteration has landed, and applies a single ordered decision: complete, blocked, iteration cap, context rollover, or continue. At the configured context threshold the loop verifies completion first; an incomplete goal is checkpointed and continued in a new agent session within the same worktree.

**Location:** `.pi/extensions/goal-loop/`

## Details

### Commands

| Command                   | Effect                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/goal <description>`     | Creates a `clarifying` record. No worktree, branch or session is created at this point.                      |
| `/goal status`            | Reports status, iterations, resets, per-criterion results, worktree, branch and pull request.                |
| `/goal stop`              | Aborts the running generation, saves the final status and starts nothing further.                            |
| `/goal resume --approve`  | Continues a paused goal after explicit approval.                                                             |
| `/goal revise`            | Returns the goal to clarification. Criteria change only through a resubmitted clarification.                 |
| `/goal cleanup --confirm` | Removes the worktree. Retention is otherwise unconditional, including after a merged or closed pull request. |

### Configuration

The `goalLoop` object in `.pi/settings.json` supplies the model and the loop limits. The configured model is used for clarification, implementation and verification regardless of the model selected for the interactive session.

```json
{
	"goalLoop": {
		"model": "provider/model-id",
		"contextRolloverTokens": 150000,
		"maxIterations": 50
	}
}
```

| Field                   | Required | Default  | Meaning                                                            |
| ----------------------- | -------- | -------- | ------------------------------------------------------------------ |
| `model`                 | yes      | —        | `provider/model-id`, resolved with the Supervisor's convention.    |
| `contextRolloverTokens` | no       | `150000` | Active-context token count that triggers a fresh-session rollover. |
| `maxIterations`         | no       | `50`     | Completed work iterations before the loop pauses for approval.     |

Three refusals guard the start. A missing, malformed or unresolvable model refuses goal execution rather than falling back to the session model. A model whose context window cannot hold the rollover threshold plus Pi's response reserve refuses execution, because the loop would otherwise be forced to compact in place exactly where it must roll over. A dirty or detached checkout is refused with instructions to commit or stash, and the existing changes are left untouched.

### State record

One record is written per goal to `<original checkout>/ignore/goals/<yyyymmdd-hhmmss>-<slug>-<rand4>.md`. The `ignore/` directory is excluded by `.gitignore`, so the record cannot reach the pull request. The front matter holds the machine-read state: request, clarified goal, criteria with their verifiers, verification evidence, status, completed iterations, context resets, generation, last checkpoint, next action, effective configuration, worktree, branch, pull request reference, blocker, steering messages and the compaction flag.

The loop writes the front matter through a temporary file and an atomic rename, and regenerates its own body sections on every write. Agent prose is confined to a marker-delimited section that is carried through verbatim. The agent never writes the file: it reports through `goal_report_iteration`, and the loop owns every write. A write failure pauses the loop and reports the last checkpoint that reached disk.

Path containment is enforced before any I/O: record ids are rejected when they contain a path separator or `..`, and the assembled path is re-verified against the record directory. A `.lock` file carrying the owning pid refuses a second goal loop in the same checkout, while a stale pid from a crashed process is taken over.

### Verification

Completion rests on evidence rather than on a claim. Every criterion is re-checked from scratch at each boundary, and prior record evidence never counts.

- A `command` verifier runs its argv array in the worktree, never through a shell. Pinned files are hashed first; a mismatch fails the criterion and the verifier is not executed, so a fix that rewrites the check script cannot pass.
- An `inspect` verifier covers criteria with no executable form. A nested fresh-context call judges `git status` and `git diff` output produced by the harness, and an unparseable verdict fails closed.

A verification pass that cannot run blocks completion and pauses the goal with the reason. Ordinary failing checks keep the goal incomplete while the agent works toward a fix.

### Boundary policy

A single ordered evaluation decides every boundary, and the same function serves the settle handler, the post-iteration check and the rollover driver:

1. **Complete** — every criterion passes and the pull request exists. The pull request is marked ready for review through the GraphQL mutation, because the REST API silently ignores `draft: false`. No merge is performed.
2. **Blocked** — the blocker is recorded and the goal pauses for user direction.
3. **Iteration cap** — the configured maximum is reached with the goal still incomplete, so the loop pauses and requires `/goal resume --approve`.
4. **Rollover** — the configured token threshold is reached, or an in-place compaction was observed.
5. **Continue** — the goal remains active for another iteration.

The completion check precedes the cap and the rollover, so a verified goal never pauses at the limit and never starts a redundant session.

### Context rollover

The threshold counts the tokens Pi reports for the active context, not cumulative billed tokens. Rollover starts a new agent session in the same worktree rather than replacing the Pi session from a lifecycle handler, which can deadlock. The fresh session receives the record only: clarified goal, criteria, next action and the worktree. Iteration and reset counts are cumulative across generations. When an in-place compaction is observed, the next boundary forces a rollover, because compaction does not reliably carry the intended continuation. A rollover that cannot start pauses the goal with the blocker and leaves the checkpoint on disk.

### Architecture

```
├── index.ts                  # /goal registration, steering input, settle boundary, session_compact
├── commands.ts               # argument parsing and command dispatch
├── tools.ts                  # goal_submit_clarification, goal_report_iteration
├── backend.ts                # production wiring for one session
├── lazy-pull-request.ts      # GitHub port resolved on first use
├── inspect-verdict.ts        # nested inspect verifier over harness evidence
├── domain/                   # record entity, ids, Markdown mapping, criteria, steering, boundary policy
├── application/              # GoalService facade, start, clarification, boundary, publication, control
├── adapters/                 # Markdown store, git workspace, GitHub PR, Pi runtime, verification runner
├── config/                   # goalLoop schema, model resolution, capacity gate
└── test/                     # entity, use-case, adapter and user-journey suites
```

The git worktree primitives, the pull-request create-or-update sequence, the model-reference resolver and the worktree removal guard live in `.pi/extensions/shared/`, and the Supervisor consumes the same modules. Goal worktrees therefore reuse the audited git argv, and pull requests reuse the audited create-or-update sequence.

### Testing

```bash
node --experimental-strip-types --test \
  '.pi/extensions/goal-loop/test/*.test.mts' \
  '.pi/extensions/shared/test/*.test.mts'
```

The suites cover configuration validation and model resolution, the clarification gate, state persistence and fail-closed parsing, worktree and pull-request failures, steering, verified completion, the configured iteration limit and repeated context rollovers. Adapter suites use temporary repositories and fake clients, so no network access and no GitHub credentials are required.
