# Long-file reduction record (#2035 — `Long File`)

The issue is filed from the CodeFlow `Architecture Issues` section: the pinned
analyzer flags every analyzed file whose raw newline-segment count exceeds a
fixed ceiling and labels the anti-pattern `Long File`. This file records what the
metric measures for this issue, what was split, what was deliberately deferred,
and where the in-gate guard lives. The register and layout follow
`long-file-2005.md`, the record for the sibling issue.

## The metric

The pinned analyzer emits the pattern as:

```js
var longFiles = files.filter(function (f) {
	return f.isCode !== false && f.lines && f.lines > 500;
});
```

with `lines = content.split("\n").length`. Two consequences drive this change:

1. **The count is raw segments, not source lines.** A newline-terminated file of
   `N` `wc -l` lines gains a trailing empty segment and counts `N+1`, so a
   500-line file _is_ flagged. Every split below lands its files at `<= 500`
   segments — `<= 499` `wc -l` lines.
2. **The ceiling is strict.** Exactly 500 segments is not flagged; 501 is. A split
   only moves the metric when _every_ original and _every_ sibling lands under
   the ceiling.

**Difference from #2005: `.mts` is scored here.** Issue #2005's set was
production `.ts`/Go/Python; `.mts` was absent from the vendored analyzer's
`codeExts` and therefore never scored. The embedded shim
(`cmd/cheasee-pi/embedded/docker/codeflow/server.py`) rewrites that list —
`_ts_rewrite(b"codeExts:['.js','.jsx','.ts','.tsx'")` — to also score
`.mts`/`.cts`, so the test suites count toward this issue's metric. That is why
the flagged set is dominated by `.mts` suites.

## Reproduction

```bash
node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs \
  <sourceDir> <codeflow-ui> <outDir>
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))
  .patterns.find(p => p.name === "Long File").metrics.files)' <outDir>/report.json
```

The in-gate oracle `test/long-file-refactor-2035.test.mts` mirrors the predicate
(`<= 500` segments) over the manifest of every original and sibling this change
touched, so the invariant that makes the number fall is enforced by `npm test`.

## What actually moved

Every split is a **verbatim relocation**: whole top-level `describe` blocks move
between test files, and the import preamble is replicated so each file is a
self-contained suite. No assertion, helper body or production import edge was
rewritten. Three families lift their shared mock builders into a non-test
harness module (`.mts`, so `node --test` never loads it as a suite) and import
them back:

- `.pi/extensions/caveman/test/caveman-harness.mts` (`makeMockPi`/`makeMockCtx`)
- `.pi/extensions/supervisor/test/duplicate-code-harness.mts` (`makeClone`)
- `.pi/extensions/ask-user/test/question-handler-harness.mts` (`makeMockCtx`)

A family only clears the metric when the original **and** all siblings are
`<= 500` segments. 25 families were split:

| original (was > 500)                                                  | siblings |
| --------------------------------------------------------------------- | -------- |
| `.pi/extensions/supervisor/test/workflow.test.mts`                    | 1        |
| `.pi/extensions/supervisor/test/config.test.mts`                      | 1        |
| `.pi/extensions/session-logger/test/session-logger-stats.test.mts`    | 1        |
| `.pi/extensions/session-logger/test/report.test.mts`                  | 1        |
| `.pi/extensions/caveman/test/caveman-index.test.mts`                  | 2        |
| `.pi/extensions/supervisor/test/duplicate-code.test.mts`              | 2        |
| `.pi/extensions/ask-user/test/question-handler.test.mts`              | 2        |
| `.pi/extensions/supervisor/test/helpers/capture.test.mts`             | 1        |
| `.pi/extensions/lsp-auditor/test/lsp-auditor.test.mts`                | 1        |
| `.pi/extensions/session-logger/test/session-logger-renderer.test.mts` | 5        |
| `.pi/extensions/ask-user/test/ask-user.test.mts`                      | 5        |
| `.pi/extensions/ripgrep-search/test/ripgrep-search.test.mts`          | 9        |
| `.pi/extensions/session-logger/test/session-logger-pipeline.test.mts` | 1        |
| `.pi/extensions/session-logger/test/session-logger.test.mts`          | 2        |
| `.pi/extensions/supervisor/test/agent-output.test.mts`                | 3        |
| `.pi/extensions/supervisor/test/agent-stream.test.mts`                | 1        |
| `.pi/extensions/supervisor/test/dead-code.test.mts`                   | 2        |
| `.pi/extensions/supervisor/test/event-adapter.test.mts`               | 2        |
| `.pi/extensions/supervisor/test/github/git.test.mts`                  | 2        |
| `.pi/extensions/supervisor/test/output.test.mts`                      | 2        |
| `.pi/extensions/supervisor/test/pipeline/crash-cleanup.test.mts`      | 2        |
| `.pi/extensions/supervisor/test/pipeline/notifications.test.mts`      | 1        |
| `.pi/extensions/supervisor/test/pipeline/worktree.test.mts`           | 1        |
| `.pi/extensions/supervisor/test/requirements-modules.test.mts`        | 1        |
| `.pi/skills/audit-codeflow-analysis/test/dry-run.test.mts`            | 1        |

## Before / after

The issue was filed with **87** flagged files (`analyzedAt 1791804971015`).
This change clears **25** of those families — each original dropped below the
ceiling and every minted sibling is below it too, so the count falls by 25
(**87 → 62**). The remaining 62 are the deferrals below plus test files whose
seam needs `it`-level extraction (a single `describe` larger than the budget, or
top-level helpers declared _between_ `describe` blocks).

## Deliberately not done

- **The 15 Rust files under `cmd/cheasee-pi/embedded/docker/ui`.** The pipeline
  image carries no Rust toolchain, so a split cannot be compiled or tested
  in-gate (#2002/#2003/#2004/#2005 precedent). Deferred to a change that can run
  `cargo test`.
- **`cmd/cheasee-pi/embedded/docker/codeflow/server.py` (1274 lines).** Its
  inline `_BRIDGE_JS`/`_UI_REWRITES` string literals and the Dockerfile `COPY`
  set form one boundary; moving code out changes that copy-set in the same
  commit. Deferred to the change that owns the boundary guard.
- **Remaining `.mts` suites with non-trivial seams** — files whose single
  `describe` exceeds the `<= 500` budget (e.g.
  `.pi/extensions/supervisor/test/pipeline/pr-creation.test.mts`,
  `structural-analyzer/test/index.test.mts`), and files whose top-level helpers
  are declared between `describe` blocks (e.g.
  `.pi/extensions/supervisor/test/pipeline/handler.test.mts`,
  `.pi/extensions/supervisor/test/pipeline/stages.test.mts`). These need
  `it`-level extraction or helper re-homing that a first pass should not guess
  at; they are candidates for a follow-up under the same issue family.

## Verification

- `test/long-file-refactor-2035.test.mts` asserts every original and sibling in
  the manifest is `<= 500` segments (the fall invariant), pins the strict
  boundary, and records the 25-family manifest.
- `npm run tsc:extensions` and `npm test` stay green; each family's
  `describe`/`it` totals are unchanged by the move.

**Assumption / risk.** The predicate is derived from the embedded shim's
`codeExts` rewrite. If that rewrite or the pinned analyzer changes, both this
record and the oracle must be re-derived (same contract as
`long-file-2005.md`).
