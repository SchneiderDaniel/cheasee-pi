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
`<= 500` segments. 71 of the 87 files were cleared (25 in the first pass, 46 in
this pass) — **87 → 16**.

## Deliberately not done

- **The 15 Rust files under `cmd/cheasee-pi/embedded/docker/ui`.** The pipeline
  image carries no Rust toolchain (`cargo`/`rustc` absent), so a split cannot be
  compiled or tested in-gate (#2002/#2003/#2004/#2005 precedent). Deferred to a
  change that can run `cargo test`; the oracle pins them so each one fails the
  gate the moment it drops under the ceiling.
- **`cmd/cheasee-pi/embedded/docker/codeflow/server.py` (1275 lines).** Its inline
  `_BRIDGE_JS`/`_UI_REWRITES` string literals are read verbatim by
  `bridge.test.mts`, the Go shim test re-materialises the file from the embedded
  FS, and the Dockerfile `COPY` + `py_compile` set treats it as one unit. Moving
  code out of it changes all four boundaries in the same commit, which this
  change does not own.

Both deferrals are pinned in `test/long-file-refactor-2035.test.mts` (`DEFERRED`)
so the set cannot drift silently.

## Verification

- `test/long-file-refactor-2035.test.mts` asserts all 87 originals exist, that
  the deferred set is exactly the still-flagged remainder, that every
  non-deferred original and sibling is `<= 500` segments, and pins the strict
  boundary.
- `npm run tsc:extensions` and `npm test` stay green; `node --test` counts the
  same number of `it` cases before and after each family move (checked by AST).

**Assumption / risk.** The predicate is derived from the embedded shim's
`codeExts` rewrite. If that rewrite or the pinned analyzer changes, both this
record and the oracle must be re-derived (same contract as
`long-file-2005.md`).
