# Complexity reduction record (#2003 — `202 High Complexity Files`)

The issue is filed from the CodeFlow `Architecture Issues` section: the pinned
analyzer titles that section with a count of files whose approximate cyclomatic
complexity exceeds a fixed ceiling. This file records what the metric actually
measures, the reproduction, the measured drop, the price paid in a neighbouring
metric, and what was deliberately left alone. The register and the layout follow
`coupling-2002.md`, the record for the sibling metric.

## The metric

`index.html` scores every analyzed file with `calcComplexity` (pinned analyzer
ref below):

```js
var patterns = [/\bif\s*\(/g, /\belse\s+if\s*\(/g, /\bwhile\s*\(/g, /\bfor\s*\(/g,
                /\bcase\s+/g, /\bcatch\s*\(/g, /\?\s*[^:]+\s*:/g, /&&/g, /\|\|/g];
var pyPatterns = [...10 Python patterns...];
var rbPatterns = [...5 Ruby patterns...];
var complexity = 1;
patterns.concat(pyPatterns, rbPatterns).forEach(function (p) {
  var m = content.match(p); if (m) complexity += m.length;
});
if (complexity > 30) level = 'critical';
```

`N High Complexity Files` therefore counts **files whose raw text contains more
than 30 branch-regex hits** — `analyzed.filter(f => f.complexity.level === 'critical')`,
where `critical` means `score > 30`. Three consequences drive this change:

1. **The score is token-proportional.** Shuffling branches between files changes
   nothing; the count falls only when _every_ sibling of a split lands `<= 30`.
   A 130-hit file needs five parts, not two.
2. **Comments and string literals are counted.** Prose and inline fixtures score
   as branches, so `if`/`for`/`and`/`or` in a doc comment or a raw-string fixture
   pay full price.
3. **Only code extensions are scored.** `analyzed[cj].isCode !== false` gates the
   call, so `.mts` (absent from `codeExts`), `.md` and `.json` score
   `{score: 0, level: 'low'}`. The `.mts` oracle for this change is consequently
   never itself a reduction source.

## Reproduction

```bash
git clone --depth 1 https://github.com/braedonsaunders/codeflow /tmp/codeflow-ui
git -C /tmp/codeflow-ui fetch --depth 1 origin b0e82d127fc4990f571ebc6da6c5d9af2591aaa1
git -C /tmp/codeflow-ui checkout --detach FETCH_HEAD

for ref in 498da2cf3fa26964b424cd8b885a4a7cbb186896 \
           da6c28275a84732817bd17fbb8422a1bce10b763; do
  rm -rf /tmp/src && mkdir -p /tmp/src
  git archive "$ref" | tar -x -C /tmp/src
  node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs /tmp/src /tmp/codeflow-ui /tmp/out
done
```

`git archive` snapshots the committed tree, so both refs are measured by the
same analyzer over the same file-set rules. The title in `report.json` →
`architectureIssues` is the metric. Both snapshots are immutable commit IDs:
`before` is `origin/main` (`498da2cf`), `after` is the branch commit the record
was written against (`da6c2827`); the commits after `after` touch only this
record, its test and the fixture, none of which the analyzer scores.

The mirror in `test/complexity-refactor-2003.test.mts` reproduces
`calcComplexity` line-for-line (24 regexes) and was verified to return the
identical flagged-file set on both snapshots: 216 on the base, 178 on the
branch.

## Before / after (pinned analyzer, same snapshot method)

| Ref           | commit     | files | complexity | coupled |
| ------------- | ---------- | ----- | ---------- | ------- |
| `origin/main` | `498da2cf` | 754   | 216        | 101     |
| this branch   | `da6c2827` | 835   | 178        | 116     |

The issue was filed with **`202 High Complexity Files`** at `analyzedAt`
1791738325602 against the then-main; re-running the pinned analyzer on the
current immutable base (`origin/main` `498da2cf`) reports **216** because main
advanced (#2001/#2002 added files that are themselves scored, and the analyzer
counts comments and string literals). The filed count is kept in the fixture's
`provenance.filedCount`; acceptance is the drop on the delivered branch.

- **`216 → 178`** flagged files (−38, −17.6 %).
- `functions` is unchanged (3539 both sides): no function was added, removed or
  renamed; the whole diff moves declarations between files of `package main`.

## What actually moved the number

Thirty-eight Go test files were split by scenario into one to five siblings
each, on file boundaries: whole top-level declarations move verbatim, and the
sibling keeps only the imports its own declarations reference. The families are
pinned in `test/fixtures/complexity-baseline.json` (`reducedBy`) and asserted by
the oracle: every original and every sibling scores `<= 30`.

The split preference was deliberate. Test files are `package main` members with
no import surface of their own, so moving a declaration between them cannot
change behaviour and cannot break a caller — the compiler and the existing
suite are the whole verification burden. The 504 `func Test...` declarations
across the 38 families are preserved one-for-one, which the oracle asserts.

The reason the remaining flags were not attacked with the same method is
arithmetic, not preference: a file needs `ceil(hits / 29)` parts, and the
remaining flags need several parts each.

## The price paid in the neighbouring metric

`N Highly Coupled` (#2002) rises **101 → 116** on the same change. The
mechanism is the detector's, not a real dependency: `coupling[conn.target] > 8`
counts the defining _files_ a file references, and the heuristic scanner counts
an identifier occurrence of any known function name without consulting imports.
A newly minted `package main` test file references the same package-level
helpers and constants as its siblings, so each new sibling crosses the eight-file
threshold. Twenty-three siblings are newly flagged and fifteen previously-flagged
paths drop off; `stats.connections` moves 2789 → 3147 while the production import
graph is untouched.

The two metrics therefore pull in opposite directions on this kind of file, which
is the warning `coupling-2002.md` already carries: a split moves edges rather
than deleting them. The complexity issue is the one under test, so the drop is
delivered and the cost is recorded in the fixture's `tradeoffs.coupling` rather
than hidden.

## Deliberately not done

- **Rust UI hunks.** Sixteen flags under `cmd/cheasee-pi/embedded/docker/ui`
  (`client.rs` 122, `stream.rs` 116, `session.rs` 108, `sessions_store.rs` 96,
  and the test files). The pipeline image carries no Rust toolchain, so a split
  cannot be compiled or tested in-gate. Left for a change that can run
  `cargo test --no-default-features --features ssr`.
- **The embedded `.sh`/`.js`/`.mjs` set.** `entrypoint.sh` (145),
  `fp-filter.js` (114), `run-analysis.mjs` (81), `worktree-fix.sh` (51),
  `verify-pi-layer-cache.sh` (56), `uninstall.sh` (77), the two `.test.sh`
  suites, `patch-pi-session-warning.js` (33) and `ponytail/index.js` (46). These
  splits must move the Dockerfile `COPY` set and the codeflow bridge/shim
  copy-set in the same commit, so they are deferred to the change that owns
  those boundary guards.
- **The TS pure-logic extractions.** The architecture plan proposes one seam per
  file (`osv-scanner.ts` → `osv-severity.ts`, `last-json-scanner.ts` →
  `json-string-state.ts`). Measured against the pinned regexes, the seam does not
  reach the ceiling: the severity half of `osv-scanner.ts` carries 72 of its 139
  hits, and the string-state machine of `last-json-scanner.ts` carries 80 of its 130. Both halves would stay `> 30`, so the extraction would move the code and
  not the metric. A split that lands every sibling under the ceiling is the
  precondition.
- **`server.py` (386).** The single largest outlier, and the root cause is the
  count itself: roughly 84 of its hits are branch keywords inside its inline
  `_BRIDGE_JS`, `_BRIDGE_SCRIPT` and `_UI_REWRITES` string literals. The plan's
  five modules would leave each sibling near 64 hits; the file needs roughly a
  dozen modules — the composition root plus one per responsibility, with the
  embedded assets housed outside the scored code extensions. That is a
  behaviour-bearing refactor of a live HTTP server and is left for its own
  change.
- **The remaining TS test suites** (`agent-harness/test/index.test.ts` 185,
  `ensureVenv.test.ts` 166, and peers). Mechanical, but each needs five to seven
  siblings; deferred rather than half-split.

The exact set, the measured before/after envelope, and the guards are pinned in
`test/fixtures/complexity-baseline.json` and replayed by
`test/codeflow-run-analysis.test.mts` (`complexity metric oracle (issue #2003)`),
including the guard that no `.mts` file is cited as a reduction source and that
no deferred path is cited as reduced.
