# God-object reduction record (#2004 — `God Object`)

The issue is filed from the CodeFlow `Architecture Issues` section: the pinned
analyzer counts files whose raw-text function count exceeds a fixed ceiling and
labels the anti-pattern `God Object`. This file records what the metric actually
measures, the reproduction, the measured drop, the price paid in neighbouring
metrics, and what was deliberately left alone. The register and the layout follow
`complexity-2003.md`, the record for the sibling metric.

## The metric

`index.html` `detectPatterns` (pinned analyzer ref below) emits the pattern as
the *same* predicate behind the architecture issue titled `N Large Files`:

```js
var godFiles = files.filter(function (f) {
  return f.isCode !== false && f.functions.length > 15;
});
```

Three consequences drive this change:

1. **The count is the parser's, not the compiler's.** `functions` comes from
   `Parser.extractOtherLanguages`, one regex per language family, deduplicated
   by `name@line`. For `.go` the shared `RULES` pass runs *in addition* to the
   `func` rule, which is why `codeflow_shim_test.go` counted 32 functions while
   declaring 21 `func Test...`.
2. **The ceiling is strict.** A file with exactly 15 functions is not flagged;
   16 is. A split only moves the metric when *every* sibling lands `<= 15`.
3. **Only code extensions are scored.** `isCode` gates files absent from
   `codeExts` (`index.html:1093`), so `.mts`, `.md` and `.json` are never
   counted. The `.mts` oracle for this change is consequently never itself a
   reduction source.

## Reproduction

```bash
git clone --depth 1 https://github.com/braedonsaunders/codeflow /tmp/codeflow-ui
# the clone head is already the pinned ref b0e82d127fc4990f571ebc6da6c5d9af2591aaa1

for ref in 279bea56d3f8b25345158f0c324b5aea2bbffb76 \
           d4fb20002a6410dd29458ccb09845013b2e56b87; do
  rm -rf /tmp/src && mkdir -p /tmp/src
  git archive "$ref" | tar -x -C /tmp/src
  mkdir -p /tmp/out && \
  node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs \
       /tmp/src /tmp/codeflow-ui /tmp/out
done
```

`git archive` snapshots the committed tree, so both refs are measured by the
same analyzer over the same file-set rules. The metric is
`report.json` → `patterns` → the entry named `God Object` → `.files.length`
(identical to the `N Large Files` architecture issue's `affectedFiles`).
`before` is `origin/main` (`279bea56`); `after` is the code tree of the
delivered branch (`d4fb2000`). The record, its oracle and the fixture land
after it and are non-code extensions, so the measurement is unchanged.

The mirror in `test/god-object-refactor-2004.test.mts` reproduces
`Parser.extractOtherLanguages` line-for-line (11 `RULES` + `GO_RULE` +
`PY_DEF`/`PY_CLASS`, dedup by `name@line`) and the `isCode` gate, and was
verified to return the identical flagged count as the analyzer on both
snapshots.

## Before / after (pinned analyzer, same snapshot method)

| Ref                  | commit     | files | God Object | Large Files | VBA God Module | coupled | complexity |
| -------------------- | ---------- | ----- | ---------- | ----------- | -------------- | ------- | ---------- |
| `origin/main`        | `279bea56` | 837   | 38         | 38          | 29             | 116     | 178        |
| this branch          | `d4fb2000` | 876   | 22         | 22          | 18             | 120     | 183        |

The issue was filed with **63** files at `analyzedAt` 1791738325602 against the
then-main; the immutable base already reports **38** because #2001/#2003 split
part of the filed set. The filed count is kept in the fixture's
`provenance.filedCount`; acceptance is the drop on the delivered branch.

- **`38 → 22`** flagged files (−16, −42.1 %).
- `functions` is unchanged (3539 both sides): no function was added, removed or
  renamed; the whole diff moves declarations between files.

## What actually moved the number

Sixteen families were split by scenario/responsibility: twelve Go test files,
one production Go file, two Python modules and the refactor-invariant suite.
Whole top-level declarations move verbatim — between files of `package main`
for Go, between modules of one package for Python — so the compiler and the
existing suites are the verification burden.

The families are pinned in `test/fixtures/god-object-baseline.json`
(`reducedBy`) and asserted by the oracle: every original and every sibling
counts `<= 15`, and the per-family declaration total is preserved
(`Σ originals+siblings == base count`).

| Family                                | before | siblings landed                     |
| ------------------------------------- | ------ | ----------------------------------- |
| `cmd/cheasee-pi/up_env_test.go`       | 34     | flags / auth / redact               |
| `cmd/cheasee-pi/codeflow_shim_test.go`| 32     | harness / entrypoint / ext          |
| `cmd/cheasee-pi/init_split_test.go`   | 30     | layout / decls / size               |
| `cmd/cheasee-pi/helpers_test.go`      | 28     | models / catalog / runner-mocks     |
| `cmd/cheasee-pi/catalog_test.go`      | 27     | remote / authadd / initkeys         |
| `cmd/cheasee-pi/init_auth_test.go`    | 25     | flow / reauth                       |
| `cmd/cheasee-pi/init_clone_test.go`   | 25     | flow / realgit                      |
| `cmd/cheasee-pi/identity.go`          | 23     | naming / gitremote / ports          |
| `cmd/cheasee-pi/ui_e2e_test.go`       | 21     | harness                             |
| `cmd/cheasee-pi/up_flow_test.go`      | 21     | journey                             |
| `cmd/cheasee-pi/up_orphans_test.go`   | 20     | scan / claim                        |
| `cmd/cheasee-pi/helpers_run_test.go`  | 19     | fixture                             |
| `cmd/cheasee-pi/init_skillrepos_test.go` | 16  | loop / terms                        |
| `scripts/.../registries.py`           | 42     | base / json / meta / simple / other |
| `scripts/.../transport.py`            | 19     | cache                               |
| `test/dependency-existence-check-refactor.test.py` | 17 | 4 scenario modules + shared harness |

The Go test files are `package main` members with no import surface of their
own, so moving a declaration between them cannot change behaviour and cannot
break a caller. `identity.go` is production `package main`; its three parts are
naming, git-remote parsing and port resolution, and the exported/unexported
surface is unchanged. `registries.py` becomes a re-export barrel over cohesive
registry-family modules; `transport.py` re-exports the cache symbols it split
into `cache.py`. The refactor suite becomes a thin `python3` entry over a
package of one module per scenario.

## The price paid in the neighbouring metrics

- **`N Highly Coupled`** (#2002) rises **116 → 120**. The mechanism is the
  detector's, not a real dependency: `coupling[conn.target] > 8` counts the
  defining *files* a file references, and the heuristic scanner counts an
  identifier occurrence of any known function name without consulting imports.
  A newly minted `package main` test file references the same package-level
  helpers and constants as its siblings, so each new sibling can cross the
  eight-file threshold. `stats.connections` moves 3147 → 3300; `functions` is
  identical, so no function was added.
- **`N High Complexity Files`** (#2003) rises **178 → 183**. The split moves
  declarations verbatim, but the newly minted siblings carry the same raw-text
  branch tokens as the originals, and `1 + Σ(hits) > 30` is token-proportional,
  so a handful of new siblings edge over it. The issue under test is God Object,
  so the drop is delivered and the cost is recorded in the fixture's
  `tradeoffs.complexity` rather than hidden.

## Deliberately not done

- **Rust UI hunks.** Sixteen flags under `cmd/cheasee-pi/embedded/docker/ui`
  (`stream.rs` 72, `retry.rs` 62, `rpc/client.rs` 57, `session.rs` 53, and the
  test files). The pipeline image carries no Rust toolchain, so a split cannot
  be compiled or tested in-gate. Left for a change that can run
  `cargo test --no-default-features --features ssr`.
- **The embedded `.sh`/`.js`/`.mjs` set.** `fp-filter.js` (18 flagged here),
  `run-analysis.mjs`, `entrypoint.sh`, `worktree-fix.sh`,
  `verify-pi-layer-cache.sh`, `uninstall.sh`, the two `.test.sh` suites,
  `patch-pi-session-warning.js` and `ponytail/index.js`. These splits must move
  the Dockerfile `COPY` set and the codeflow bridge/shim copy-set in the same
  commit, so they are deferred to the change that owns those boundary guards.
- **`test/dependency-existence-check.test.py` (106 functions, 62 tests).** Needs
  roughly eight scenario modules plus a harness split. Its two largest
  `TestCase` classes carry 21 functions each, so landing every sibling `<= 15`
  requires base-class declarations that add names per split — a structural
  change to the very suite that guards the package, and one whose per-family
  declaration total can no longer be pinned by a verbatim-move invariant. The
  architecture trade-off explicitly sanctions splitting the Go files first and
  deferring this queue to its own recorded change; the suite stays green and is
  the regression guard for the two Python modules that *are* split here.
- **The remaining TS/Python flags.** `server.py` (386), `osv-scanner.ts` (140)
  and `last-json-scanner.ts` (131) need a multi-module decomposition rather than
  the plan's single seam: the severity half of `osv-scanner.ts` carries 72 of
  its branch hits and the string-state machine of `last-json-scanner.ts` 80, so
  both halves would stay `> 15` and the metric would not move. `server.py`'s
  inline `_BRIDGE_JS`/`_UI_REWRITES` string literals carry 84 of its hits, so it
  needs roughly a dozen modules. Deferred to changes that can verify the
  decomposition.

The exact set, the measured before/after envelope, and the guards are pinned in
`test/fixtures/god-object-baseline.json` and replayed by
`test/codeflow-run-analysis.test.mts` (`god object metric oracle (issue #2004)`),
including the guard that no `.mts` file is cited as a reduction source and that
no deferred path is cited as reduced.
