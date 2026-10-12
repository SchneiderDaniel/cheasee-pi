# Long-file reduction record (#2005 — `Long File`)

The issue is filed from the CodeFlow `Architecture Issues` section: the pinned
analyzer flags every analyzed file whose raw newline-segment count exceeds a
fixed ceiling and labels the anti-pattern `Long File`. This file records what the
metric actually measures, the reproduction, the measured drop, the price paid in
neighbouring metrics, and what was deliberately left alone. The register and the
layout follow `god-object-2004.md`, the record for the sibling metric.

## The metric

`index.html:1411-1412` (pinned analyzer ref below) emits the pattern as:

```js
var longFiles = files.filter(function (f) {
  return f.isCode !== false && f.lines && f.lines > 500;
});
```

with `lines = content.split("\n").length`. Three consequences drive this change:

1. **The count is raw segments, not source lines.** A file whose last line ends
   with a newline gains a trailing empty segment, so a 500-line file that ends in
   `\n` counts 501 and *is* flagged. Every split below lands its files at `<=
   500` segments, which is `<= 499` `wc -l` lines for a newline-terminated file.
2. **The ceiling is strict.** Exactly 500 segments is not flagged; 501 is. A
   split only moves the metric when *every* original and *every* sibling lands
   under the ceiling — one fat sibling keeps the family flagged.
3. **Only code extensions are scored.** `isCode` gates files whose extension is
   absent from `codeExts`/`scriptContainerExts`. `.mts`, `.json` and `.md` are
   not members, so this record, its oracle and its fixture are never counted —
   and the oracle refuses any `.mts` path as a reduction source.

Metric accessor: `report.json → patterns["Long File"].metrics.files`.

## Reproduction

```bash
# the CodeFlow clone head is already the pinned ref b0e82d127fc4990f571ebc6da6c5d9af2591aaa1
git -C <codeflow-ui> rev-parse HEAD

# before: the immutable base of this branch
git archive 4dcddf80055180c2a4f766fc3316afaf01a46796 | tar -x -C /tmp/before
node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs \
  /tmp/before <codeflow-ui> /tmp/out-before
node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/out-before/report.json"))
  .patterns.find(p => p.name === "Long File").metrics.files)'

# after: the delivered tree (same command against `git archive HEAD` of the branch)
```

The in-gate oracle `test/long-file-refactor-2005.test.mts` mirrors the predicate
line-for-line and asserts the invariant that makes the number fall — every
original and sibling in the manifest is `<= 500` segments and not flagged. The
recorded envelope lives in `test/fixtures/long-file-baseline.json` and is
replayed by the `long file metric oracle (issue #2005)` block in
`test/codeflow-run-analysis.test.mts`.

## Before / after (pinned analyzer, same snapshot method)

| | commit | tracked files | `Long File` |
|---|---|---|---|
| before | `4dcddf80` (`origin/main` after #2004) | 1194 | **35** |
| after | delivered branch | 1240 | **16** |

The issue was filed with **61** files at `analyzedAt 1791738325602`. The number
had already fallen to 35 on the immutable base, because #2001 (Large Files),
#2002 (Highly Coupled), #2003 (High Complexity) and #2004 (God Object) split
overlapping parts of the same file set — the issue itself notes the per-issue
file isolation is best-effort, not disjoint. Acceptance is the drop on the
delivered branch: **35 → 16, all 19 non-deferred families cleared**.

## What actually moved the number

Every split is a verbatim relocation; no declaration was rewritten. The four
kinds of seam:

- **Production halves.** `agent-loop.ts` → `agent-loop-helpers.ts` (the five
  top-level helpers), `osv-scanner.ts` → `osv-severity.ts` (types + severity
  mapping + CVSS + parse), `merge.ts` → `merge-conflicts.ts` + `pr-gate.ts`,
  `worktree.ts` → `worktree-deps.ts`, `agent/runner/index.ts` →
  `runner/spawned-run.ts`, `ripgrep-search/index.ts` → `render.ts` + `summary.ts`.
  Each original keeps its exported names as explicit named re-exports
  (`export { x } from "./sibling.ts"`), so no public name and no import edge
  changed; `pipeline/index.ts` still reaches `handleSupervisorCommand` through
  `./handler.ts`.
- **TS test suites.** Whole `describe` blocks move to scenario siblings and the
  shared fixture helpers move to non-`.test.ts` modules (`harness-fixtures.ts`,
  `fixtures.ts`, `web-search-fixtures.ts`, `python-adapter-fixtures.ts`,
  `lib/test/ensureVenv-fixtures.ts`), so `node --test` does not load the helpers
  as suites. Per family the `describe`/`it` totals are unchanged
  (agent-harness 24/143, ensureVenv 11/49, index-handler 8/61, web-search 12/40,
  python-adapter 6/37 …).
- **Go test suites.** Whole `func Test…` declarations (and the shim harness they
  share) move between files of `package main`; the compiler and the existing
  suite are the verification.
- **Python safety-net suite.** `test/dependency-existence-check.test.py` becomes
  a thin `python3` entry over `test/dependency_existence_check_tests/`
  (`_common.py` harness + one module per `TestCase` class). 62 tests before and
  after. The package is *not* named `dependency_existence_check`: the suite's
  importlib shim registers the production module under that exact name in
  `sys.modules`, so a package of the same name could not be imported.

Two pin suites read the moved sources by path, so they now read the loop module
as `agent-loop.ts` + `agent-loop-helpers.ts`
(`.pi/extensions/supervisor/test/pipeline/agent-loop-rebase.test.mts`,
`gate-failure-context.test.mts`, `supervisor-issue-525.test.mts`,
`supervisor-bugs-freeze.test.mts` for the runner split). That is a reviewed
re-point of an existing source pin, not a behaviour change.

## The price paid in the neighbouring metrics

- **Coupling** can rise: a minted sibling references the same package-level
  helpers/constants as its siblings, so the #2002 heuristic (a file referencing
  more than 8 defining files) can count it as coupled.
- **Complexity** can rise: the split moves whole declarations verbatim, but each
  new sibling carries its own raw-text branch tokens (comments and string
  literals included) under the `1 + Σ(hits) > 30` ceiling, so a handful of new
  siblings can edge over it.

Both are recorded in the fixture's `tradeoffs` rather than hidden. No production
import-graph edge was added.

## Deliberately not done

- **The 15 Rust files under `cmd/cheasee-pi/embedded/docker/ui`.** The pipeline
  image carries no Rust toolchain, so a split cannot be compiled or tested
  in-gate (#2002/#2003/#2004 precedent). Deferred to a change that can run
  `cargo test`.
- **`cmd/cheasee-pi/embedded/docker/codeflow/server.py` (1304 segments).** Its
  inline `_BRIDGE_JS`/`_UI_REWRITES` string literals and the Dockerfile `COPY`
  set form one boundary; moving code out of the file changes that copy-set in
  the same commit. Deferred to the change that owns the boundary guard.
- **Renaming or re-homing code into non-scored extensions to dodge the metric.**
  The oracle guards `reducedBy` against `.mts` paths and against any path that is
  also listed under `deferred`.

The exact manifest, the measured envelope and the guards are pinned in
`test/fixtures/long-file-baseline.json`, enforced by
`test/long-file-refactor-2005.test.mts` and replayed by
`test/codeflow-run-analysis.test.mts` (`long file metric oracle (issue #2005)`).

**Assumption / risk.** The predicate is derived from the external pinned analyzer
`b0e82d1`; if the CodeFlow checkout is re-pinned, this mirror must be re-derived
(same contract as `coupling-2002.md` / `complexity-2003.md` /
`god-object-2004.md`).
