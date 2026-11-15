---
name: test-validator
description: "Audit every runnable test for evidence-based regression or contract value, decide GOOD or BAD per test with a resumable checkpoint, and request maintainer review of the BAD ones in exactly one GitHub issue. Use when asked to find worthless, tautological, or framework-only tests."
disable-model-invocation: true
metadata:
  steps: discover-judge-checkpoint-report-file-issue
  scope: issues-only-no-commits
  dependencies: scripts/test-validator.mts, criteria.md, config.json, gh, supervisor.repo
---

# Test Validator

Judge **every runnable test** in this repository against one written quality bar
and file **one** issue asking maintainers to review the ones that carry no
signal. The skill never edits or removes a test.

Running it costs one model call per discovered test (thousands of calls on a
large suite). `disable-model-invocation: true` is deliberate: start it on
purpose, never by inference.

## Hard Rules

- **This run is decided by evidence, not vibes.** `BAD` requires all three: a
  confidence at or above `badConfidenceThreshold`, at least one evidence quote
  that is a verbatim substring of the judged lines _inside_ the judged range,
  and at least one BAD-qualifying criterion (`C1`, `C2`, or `C3`). Anything else
  stays `PENDING` and is retried, never guessed.
- **Ambiguity is not badness.** A test the slice cannot settle is retried up to
  `maxAttempts`; if it never resolves, the run is **incomplete**: no report, no
  issue, exit `3`. A partial audit never presents itself as complete.
- **Exactly one issue**, only after every discovered test is `GOOD` or `BAD`,
  listing only the BAD tests. Zero BAD tests means no issue at all.
- **Never delete, edit, or disable a test.** The issue asks a maintainer to
  review and remove; removal stays a human decision. No branches, no commits, no
  pull requests.
- **Resume beats restart.** Each completed decision is appended to the
  checkpoint, so an interrupted run continues where it stopped. A changed
  inventory or model configuration refuses to resume — the verdicts described a
  different audit — and demands `--restart`, which archives the old checkpoint
  instead of deleting it.
- **Preconditions fail before the first model call.** Missing provider API key,
  unauthenticated `gh`, absent `supervisor.repo`, or an unresolvable test file
  halts with a non-zero exit. None of them is recorded as a per-test verdict.
- **The API key is read from the environment only.** It is never written to
  `config.json`, the checkpoint, or the report.

## Preconditions

- Node runs with `--experimental-strip-types` (this repository's npm scripts do).
- `supervisor.repo` is set in the **repo-root** `.pi/settings.json` (never read
  from the git remote).
- The provider named in `config.json` has its API key in the environment (for
  `openai`: `OPENAI_API_KEY`).
- `gh auth status` succeeds for an account that can file issues on
  `supervisor.repo`.

## Configuration

`config.json` holds everything the run needs:

| Field                          | Meaning                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `provider`                     | pi-ai provider id, e.g. `openai`                            |
| `model`                        | model id for that provider                                  |
| `concurrency`                  | model calls in flight (bounds rate-limit exposure)          |
| `badConfidenceThreshold`       | minimum confidence for a BAD verdict                        |
| `maxAttempts`                  | attempts per test before it stays pending                   |
| `haltAfterConsecutiveFailures` | circuit breaker: stop the run after N failed calls in a row |

Changing `provider`, `model`, `badConfidenceThreshold`, or `criteria.md`
invalidates a checkpoint. Changing `concurrency`, `maxAttempts`, or
`haltAfterConsecutiveFailures` does not: those affect how the run proceeds, not
what a verdict means.

`criteria.md` is the quality bar itself. Criterion ids (`C1`–`C7`) are parsed
from its `## C<n> —` headings, so the file and the parser cannot drift.

## Workflow

### Step 1 — Pilot the cost (optional but recommended)

```bash
node --experimental-strip-types .pi/skills/test-validator/scripts/test-validator.mts --limit 20
```

`--limit` judges a prefix of the inventory. The checkpoint then describes a
truncated inventory, so the full audit afterwards needs `--restart`. Use it to
measure tokens and wall-clock time per test before paying for the whole suite,
and to sanity-check the verdict quality in the report.

### Step 2 — Run the audit

```bash
node --experimental-strip-types .pi/skills/test-validator/scripts/test-validator.mts
```

The run enumerates **every test file this repository runs**, across languages,
then judges each test unit in an isolated, tool-less model call that sees exactly
one slice plus its enclosing scope and the file's imports. Verdicts stream to the
checkpoint; progress goes to stderr.

Discovery covers, in one pass:

| Language   | Files enumerated                                | Unit judged                                          |
| ---------- | ----------------------------------------------- | ---------------------------------------------------- |
| TypeScript | the `scripts.test` globs plus every `*.test.*`  | one `node:test` call site (`.skip`/`.todo` excluded) |
| Go         | every `*_test.go`, when the repo has a `go.mod` | one `func Test*` / `func Fuzz*` / `func Example*`    |
| Python     | `test_*.py`, `*_test.py`, `*.test.py`           | one `def test_*` function or method                  |
| Shell      | every `*.test.sh` / `*.test.bash`               | the script as a whole                                |

Three rules keep the completion claim honest:

1. **No file is silently skipped.** A runnable test file that yields no
   statically enumerable call site becomes **one whole-file definition** (a shell
   script, a script-style `python3 test/foo.test.py`, a custom node harness).
2. **Non-tests are named, not dropped.** `.skip`/`.todo` call sites, Go
   benchmarks (`not-run-by-default`), and `_test.go` files that only carry
   helpers (`test-support-file`) are listed in the report's `excluded[]`.
3. **Vendored code is not audited.** `node_modules`, `ignore/`, `vendor`,
   caches, and nested checkouts under `.pi/git/` are not this project's suite.

An unenumerable or unparsable test file halts the run (exit `2`): a partial
inventory must never reach the gate.

**What is not audited.** The claim is "every test this repository runs", not
"every file that mentions a test". The only test files present here outside the
four families above belong to the Rust/WASM UI crate
`cmd/cheasee-pi/embedded/docker/ui/`: its `tests/*.rs` integration targets and
the `#[cfg(test)]` modules beside its sources. No CI job, `npm`/`go`/`bash`/
`python` script, or documented command compiles or runs them — no Rust toolchain
ships in the image or an in-gate lane — so they are outside this run's scope.
`test/inventory-scope.test.mts` enforces that: any test suite appearing in a
language this audit cannot enumerate fails that guard until an enumerator is
added. If a Rust (or any other) runner is ever wired into CI, add its enumerator
before trusting the completion claim; the report's `coverage` field is what makes
the claim checkable.

Artifacts:

| Path                                     | Content                                                       |
| ---------------------------------------- | ------------------------------------------------------------- |
| `ignore/test-validator/checkpoint.jsonl` | header + one record per decision (the resume state)           |
| `ignore/test-validator/report.json`      | the completed audit (written only when all tests are decided) |

Both live under the gitignored `ignore/` tree: an entry-by-entry report of
thousands of tests is not worth committing, and the issue carries what a
maintainer needs.

### Step 3 — Resume an interrupted run

Just run the same command again. Completed decisions are reused, only the
remaining tests are judged, and a previously filed issue is found by its hidden
run marker instead of being filed twice.

If the run stops with `inventory changed: added N, removed M, modified K`, the
tree no longer matches the checkpoint: rerun with `--restart` to archive the old
checkpoint to `ignore/test-validator/archive/<timestamp>.jsonl` (nothing is
deleted) and judge everything again.

### Step 4 — Report the outcome

The command prints three lines — the counts, the report path, and the issue URL
(or `issue: none`). Pass them to the user verbatim; on `exit 3` state that the
audit is incomplete and no issue was filed, and on `exit 1` quote the halt
reason.

## Exit codes

| Exit | Meaning                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | every discovered test is GOOD or BAD; report written, at most one issue filed                      |
| `1`  | halted: precondition (API key, `gh auth`, `supervisor.repo`), model, checkpoint, or filing failure |
| `2`  | usage error, or the inventory could not be resolved (unparsable test file)                         |
| `3`  | incomplete: tests stayed pending, so no report and no issue were produced                          |

## What the issue contains

- Title `Test quality review: N BAD tests`.
- One line per BAD test: `file:start-end`, the test name, the cited criteria,
  and the one-sentence reason.
- The audited coverage (`N test file(s) covering typescript …, go …`), so a
  maintainer can check the completion claim instead of trusting it.
- A hidden `<!-- test-validator-run:<fingerprint> -->` marker that makes the
  issue findable on resume.
- An explicit statement that the audit never removes tests and that removal is
  the maintainer's call.

Oversized bodies fail closed (exit `1`) rather than being truncated: a partial
list would silently drop findings.

## Evidence, one level down

- **Enumerating files** (`lib/inventory-repository.ts`): the only discovery
  module that touches the filesystem. Union of the runner's own globs
  (`package.json` `scripts.test`), conventional per-language names, and a
  directory walk that skips dependencies, caches, build output, and nested
  checkouts.
- **Per-language discovery** (`lib/inventory-file.ts`, `lib/inventory.ts`,
  `lib/inventory-go.ts`, `lib/inventory-python.ts`): node files use the
  TypeScript AST, so only bindings imported from `node:test` count and a
  same-named local helper is not a test; Go files use brace counting that skips
  comments and literals; Python files use indentation blocks; shell scripts are
  whole-file units. A computed call target (`globalThis["it"](…)`), an
  unparsable file, or an unsupported file kind throws, halting the run.
- **Judge** (`lib/adapters/decision-model-pi-ai.ts`): one `completeSimple` call
  with a fresh context, no tools, no session. The prompt carries the criteria,
  the slice, the describe header, and the file's imports — never another test's
  body.
- **Verdict gate** (`lib/decision.ts`): strict JSON only; any deviation from the
  schema, an unknown criterion, an out-of-range line, or a non-verbatim quote
  yields PENDING.
- **Checkpoint** (`lib/checkpoint.ts`, `lib/checkpoint-schema.ts`): append-only
  JSONL with a fingerprint header, a torn-tail-tolerant reader, and a
  single-writer lock. Every record is schema-validated before it is replayed —
  a tampered `decision`, an unknown record type, or a header from another schema
  version halts instead of being reused as a completed verdict. Middle-of-file
  corruption halts; it is not truncation.
- **Run** (`lib/run.ts`): bounded worker pool, per-test retries, circuit
  breaker, completion gate, and filing idempotency. Only the coordinator
  appends.
- **Report and issue** (`lib/report.ts`): pure policy for what appears in the
  JSON and in the issue body.
