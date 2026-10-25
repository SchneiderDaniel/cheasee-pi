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
(`<= 500` segments) over the complete 87-file set the issue named, plus every
sibling each split minted (discovered by stem prefix), so the invariant that
makes the number fall is enforced by `npm test`.

## What actually moved

Every split is a **verbatim relocation**: whole top-level `describe` blocks move
between test files, and the import preamble is replicated (then pruned to the
bindings each sibling actually uses, so `extension-test-imports.test.mts` stays
green). No assertion or production import edge was rewritten. Where a lone
`describe` was larger than the budget, its inner `it`/`describe` units are
re-distributed under a re-emitted clone of the same `describe` title and its
pre-hooks; a statement that registers tests but is not a `describe`/`it` call
(e.g. a `for…of` over cases) is kept whole in one bin rather than duplicated.

Three families lift shared fixture data into a non-test module (`.mts`, so
`node --test` never loads it as a suite) and import it back:

- `.pi/extensions/session-logger/test/session-logger-renderer-golden-fixtures.mts`
  (`CASES` + builders)
- `.pi/extensions/supervisor/test/checks/osv-scanner-fixtures.mts` and
  `osv-scanner-fixtures-b.mts` (JSON fixtures)
- `.pi/skills/audit-codeflow-analysis/scripts/dry-run-lib.mts` /
  `dry-run-args.mts` (the `dry-run.mts` CLI split into pure helpers + CLI)

A family only clears the metric when the original **and** all siblings are
`<= 500` segments. All 87 files are cleared — **87 → 0**. The first two passes
split the TypeScript/Go/Python families (25, then 46); this pass completes the
set with the 15 Rust sources and `server.py` (below).

## The Rust family

The Rust sources under `cmd/cheasee-pi/embedded/docker/ui` are split into real
`mod` declarations by #2036 (merged into this branch), so #2035 only had to take
over the coalesced result: `stream.rs` → `stream/{assembler,chat,rows,tests}.rs`,
`session.rs` → `session/relay.rs` + `session/tests.rs`, `rpc/client.rs` →
`rpc/client/{tests,tests_delivery,replay}.rs`, and the integration suites under
`tests/<name>/`. `rpc/client.rs` was the one file #2036 left at 535 segments, so
this change moved the live replay adapter (`RpcReplaySource`) into
`rpc/client/replay.rs` and re-exported it (`pub use replay::RpcReplaySource;`),
leaving the request lifecycle at 415 segments and the adapter at 133.

The pipeline image carries no Rust toolchain (`which cargo rustc` is empty), so
none of these splits can be compiled in-gate; they are verbatim relocations with
`use super::*;` at the top of each child module, and the behaviour proof for the
crate remains the CI check that owns it.

## The server.py facade

`cmd/cheasee-pi/embedded/docker/codeflow/server.py` (1275 lines at filing) was
already a facade over `config.py`, `report_store.py`, `analysis_run.py`,
`repo_identity.py` and `ui_rewrites.py` when this branch started, and still
measured 568 segments — the inline `_BRIDGE_JS` browser asset. That literal now
lives in `bridge_js.py` (128 lines, its explanatory comment included) and
`server.py` re-exports it as `_BRIDGE_JS` (`from bridge_js import BRIDGE_JS as
_BRIDGE_JS`), so `runpy.run_path` sees the same module namespace the Go harness
and the bridge suites read, and `/codeflow-bridge.js` serves the same bytes. The
Dockerfile `COPY` set, the `py_compile` gate and the Go harness module list all
cover the new file.

Both families are pinned by `test/long-file-refactor-2035.test.mts` (`DEFERRED`
is still empty, so a dropped file cannot slip under the ceiling unnoticed).

## Verification

- `test/long-file-refactor-2035.test.mts` asserts all 87 originals exist, that
  the deferred set (now empty) is exactly the still-flagged remainder, that every
  original and every sibling of any extension (`.mts`/`.ts`/`.rs`/`.py`, including
  the nested `tests/<name>/` and `<module>/` siblings) lands `<= 500` segments,
  and pins the strict boundary.
- `npm run tsc:extensions` and `npm test` stay green; `node --test` counts the
  same number of `it` cases before and after each family move (checked by AST).

**Assumption / risk.** The predicate is derived from the embedded shim's
`codeExts` rewrite. If that rewrite or the pinned analyzer changes, both this
record and the oracle must be re-derived (same contract as
`long-file-2005.md`).
