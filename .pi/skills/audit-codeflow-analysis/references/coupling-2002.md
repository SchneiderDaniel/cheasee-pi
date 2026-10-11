# Coupling reduction record (#2002 — `134 Highly Coupled`)

The issue is filed from the CodeFlow `Architecture Issues` section: the pinned
analyzer titles that section with a count of files whose *resolved cross-file
identifier references* exceed a fixed threshold. This file records what the
metric actually measures, the reproduction, the measured drop, and what was
deliberately left alone.

## The metric

`index.html` builds it from the connection list (pinned analyzer ref below):

```js
var coupling = Object.create(null);
conns.forEach(function (c) { coupling[c.target] = (coupling[c.target] || 0) + 1; });
var highCoup = Object.entries(coupling).filter(function (x) { return x[1] > 8; });
if (highCoup.length) issues.push({ title: highCoup.length + ' Highly Coupled', ... });
```

So `N Highly Coupled` counts **files that reference more than 8 distinct
(definingFile, functionName) pairs** — it is a per-file fan-out count, not a
static import graph. The unit was pinned by experiment in issue #1995: the
headless run has no Babel/acorn/TreeSitter, so sources are parsed in
`heuristic-regex` mode and `Parser.findCalls` counts each identifier occurrence
of a known function name. Two consequences drive this change:

1. **A name that has exactly one definition repo-wide collects an edge from
   every file that merely mentions that identifier** — `defs.length === 1`
   short-circuits resolution without consulting imports. A helper named `slice`,
   `dir`, `body`, `write` or `result` therefore imports every file that uses a
   same-named method or word.
2. **A definition read out of a comment or a string literal is a phantom** whose
   "callers" are every file containing that word. The assembly-language regexes
   in `Parser.extractOtherLanguages` run for *every* non-Python file when the
   headless run has no acorn, so prose like `… MkdirAll(dir, 0755)` or
   `an internal error only (e.g. …)` declares a function named `MkdirAll` or
   `only`.

Both are *non-dependency* edges: the referencing file never calls the
definition. Removing them is the only way to move this metric, because splitting
a flagged file moves its edges to the new file rather than deleting them (the
architecture note's own warning: splitting only helps when *each* part falls
back under the threshold).

## Reproduction

```bash
git clone --depth 1 https://github.com/braedonsaunders/codeflow /tmp/codeflow-ui
git -C /tmp/codeflow-ui fetch --depth 1 origin b0e82d127fc4990f571ebc6da6c5d9af2591aaa1
git -C /tmp/codeflow-ui checkout --detach FETCH_HEAD

for ref in origin/main HEAD; do
  rm -rf /tmp/src && mkdir -p /tmp/src
  git archive "$ref" | tar -x -C /tmp/src
  node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs /tmp/src /tmp/codeflow-ui /tmp/out
done
```

`git archive` snapshots the committed tree, so both refs are measured by the same
analyzer over the same file-set rules. The title in `report.json` →
`architectureIssues` is the metric; the envelope's `stats.connections` is the
term input.

## Before / after (pinned analyzer, same snapshot method)

| Ref | files | functions | connections | coupled | coupling term |
|-----|-------|-----------|-------------|---------|---------------|
| `origin/main` | 731 | 3555 | 3310 | 134 | 3.056 |
| this branch | 731 | 3542 | 2668 | 97 | 1.300 |

Both snapshots were taken on this branch's tree **before** it was merged with
`origin/main` (the merge brought #2001's file splits in). Every edit listed
below survived that merge; the only moved one is `identity` →
`identityPassThrough`, which #2001 relocated from `test/helpers/capture.ts` into
`test/helpers/mock-pi.ts`. The file/functions columns of the `after` snapshot
are therefore pre-merge figures.

- **`134 → 97`** flagged files (−37, −27.6 %); the coupling term
  `min(15, max(0, connections/files − 3) · 2)` falls `3.056 → 1.300`.
- `functions` drops by 13 because the invented declarations disappear; the
  dead-code term is unchanged (`1.266 → 1.270`, `dead` 45 both sides) — no real
  function was removed or hidden.

## What actually moved the number

**Pass 1 — delete phantom definitions.** Prose and string literals the
heuristic scanner reads as declarations. Reworded in:
`codeflow/fp-filter.js`, `embedded/docker/entrypoint.sh`,
`supervisor/pipeline/handler/agent-loop.ts`, `auth.go`, `config_jsonfile.go`,
`init.go`, `uninstall.go`, `up_compose.go`, `root_test.go`, `provider_test.go`,
and in the Go/TS fixture literals of `init_split_test.go`,
`.pi/extensions/agent-harness/lib/timed-map.test.ts`,
`.pi/extensions/agent-harness/test/index.test.ts`.

**Pass 2 — disambiguate collision-prone private helpers.** Renames only, no
behaviour change, each verified by its own compiler/test suite:

| old | new | file |
|-----|-----|------|
| `write` / `child` | `writeLogRecord` / `childLogger` | `.pi/extensions/supervisor/lib/debug.ts` |
| `all` / `size` / `flush` | `allRecords` / `recordCount` / `drain` | `.pi/extensions/supervisor/pipeline/error-collector.ts` |
| `identity` | `identityPassThrough` | `.pi/extensions/supervisor/test/helpers/mock-pi.ts` |
| `entry` / `config` | `makeEntry` / `makeConfig` | `.pi/extensions/caveman/test/session-level.test.ts` |
| `exists` | `pathExists` | `.pi/extensions/lib/ensureVenv.test.ts` |
| `stdout` | `renderStdout` | `.pi/extensions/scrapling/test/python-adapter.test.ts` |
| `build` | `buildThing` | `.pi/extensions/lib/test/source-graph.test.ts` |
| `slice` | `sliceFixtureSection` | `.pi/skills/audit-codeflow-analysis/test/fixtures/generate-report-fixtures.mjs` |
| `indexOf` | `indexOfArg` | `cmd/cheasee-pi/up_env_test.go` |
| `configPath` | `repositoryConfigPath` | `cmd/cheasee-pi/config.go`, `config_jsonfile.go` |
| `writeFile` | `writeShimFile` | `cmd/cheasee-pi/codeflow_shim_test.go`, `codeflow_shim_fp_filter_test.go` |
| `variant` | `permute_blobs` | `cmd/cheasee-pi/codeflow_shim_fp_filter_test.go` (embedded Python fixture) |

The renamed symbols' only readers are test files, which the pinned analyzer
never counts as call sites, so the `.mts` call-site updates appear in the
fixture's `callSiteOnly` list rather than in `reducedBy`. (`up_env_test.go` and
`codeflow_shim_*_test.go` are `.go` files, so the analyzer does count them —
hence they sit in `reducedBy`.)

The exact set, the measured before/after envelope, and the guards are pinned in
`test/fixtures/coupling-baseline.json` and replayed by
`test/codeflow-run-analysis.test.mts` (`coupling metric oracle (issue #2002)`),
including the guard that no test-only `.mts` file is cited as a reduction source.

## Deliberately not done

- **Trait / interface implementations.** `framing.rs fn clone`, `config.go
  Path()`, `helpers_test.go Run()/Output()/CombinedOutput()` sit at 33–37
  references each and are pure detector noise, but the names are the port
  contract; renaming them would be a wide, meaningless churn. Documented as a
  detector limitation.
- **Rust UI hunks.** `sessions_store.rs dir/resolve/list`, `protocol.rs body`,
  `controls.rs parse` are the same kind of collision (57–72 references each) and
  renaming them is mechanically the largest remaining win, but the pipeline
  image has no Rust toolchain, so the change cannot be verified in-gate.
  Left for a change that can run `cargo test --no-default-features --features ssr`.
- **File splits (the test plan's phases 1–7).** Not applied. The plan's own
  trade-off note accepts this: a split only helps when *each* part falls back
  under the threshold, and splitting a 36-reference coordinator yields two
  ~18-reference files — still above `> 8`, so the flagged count does not move
  while the diff and the analyzed file count both grow. Phase 8 (the measured
  gate) *was* executed and is what this record pins; phases 1–7 were the plan's
  hypothesis about how the number would move, and the measurement disproved it
  in favour of the two passes above.
- **Rust `session.rs` / `main.rs` / `stream.rs`.** Flagged for coupling too, but
  the same split arithmetic applies and the toolchain is absent in-gate, so any
  change there would be an unverifiable guess. Left for the Rust-capable change
  noted above.
