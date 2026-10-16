# VBA-god-module reduction record (#2006 — `VBA God Module`)

The issue is filed from the CodeFlow `Architecture Issues` section: the pinned
analyzer counts files whose raw-text function count exceeds a fixed ceiling and
labels the anti-pattern `VBA God Module`. This file records what the metric
actually measures, the reproduction, the measured drop, the rules that decide
what may be split in-gate, and what was deliberately left alone. The register and
the layout follow `god-object-2004.md`, the record for the metric this one is a
strict subset of.

## The metric

`index.html` `detectPatterns` (pinned analyzer ref below) emits the pattern as
the _same_ predicate behind `God Object`, at a higher ceiling:

```js
var vbaGodFiles = files.filter(function (f) {
	return f.isCode !== false && f.functions && f.functions.length > 20;
});
```

Four consequences drive this change:

1. **The count is the parser's, not the compiler's.** `functions` comes from the
   headless parser (`Parser.extractOtherLanguages`) — one regex per language
   family — plus the python branch that counts every `def` at any indent and
   every `class`. `.py` counts nested helpers too, which is why the two suites
   below already sat at 21 declarations each after #2005's split.
2. **The ceiling is strict.** A file with exactly 20 declarations is not
   flagged; 21 is. A split only moves the metric when _every_ sibling lands
   `<= 20`.
3. **`VBA God Module` is a strict subset of `God Object`** (`> 15`, same
   predicate, `index.html:1412`), and `God Object` is the metric behind the
   `N Large Files` architecture issue. A split that only reaches `<= 20` can
   _mint_ a God Object regression, so this change targets `<= 15` per sibling
   and records the expected co-benefit.
4. **Only code extensions are scored.** `isCode` gates files absent from
   `codeExts` (`index.html:1093`), so `.mts`, `.md` and `.json` are never
   counted. The shared mirror, this issue's oracle, its fixture and this record
   are therefore never reduction sources — the oracle asserts that.

## Reproduction

```bash
git clone --depth 1 https://github.com/braedonsaunders/codeflow /tmp/codeflow-ui
# the clone head is already the pinned ref b0e82d127fc4990f571ebc6da6c5d9af2591aaa1

for ref in 2b053c2bb3a0c35b9736598467e0be8c5402a8ee \
           db16ddbb0c84e1d21274e10ff94486cdc0d3259c; do
  rm -rf /tmp/src /tmp/out && mkdir -p /tmp/src /tmp/out
  git archive "$ref" | tar -x -C /tmp/src
  node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs \
       /tmp/src /tmp/codeflow-ui /tmp/out
done
```

`git archive` snapshots the committed tree, so both refs are measured by the
same analyzer over the same file-set rules. The metric is
`report.json` → `patterns` → the entry named `VBA God Module` → `.files.length`.
`before` is `origin/main` after #2001–#2005 (`2b053c2b`); `after` is the
code-tree commit of this branch (`db16ddbb`), which carries the Python split and
the shared mirror. The artifacts that follow it are `.json`/`.mts`/`.md` (never
scored) plus comment-only docstring corrections in the six split `.py` modules,
so the delivered tree re-measures the same count.

The mirror in `test/fixtures/function-count-mirror.mts` reproduces the analyzer's
parser (`11 RULES` + `GO_RULE` + `PY_DEF`/`PY_CLASS`, dedup by `name@line`) and
the `isCode` gate; it returns the identical count as the analyzer on all
nineteen flagged files of the base snapshot, and it is the single source the
`#2004` god-object oracle now imports too.

## Before / after (pinned analyzer, same snapshot method)

| Ref           | commit     | files | VBA God Module | God Object | Long File | functions |
| ------------- | ---------- | ----- | -------------- | ---------- | --------- | --------- |
| `origin/main` | `2b053c2b` | 922   | 19             | 25         | 16        | 3552      |
| this branch   | `db16ddbb` | 927   | 17             | 23         | 16        | 3558      |

The issue was filed with **44** files at `analyzedAt` 1791738325602 against the
then-main; the immutable base already reports **19** because #2001–#2005 cleared
the Go/TS part of the filed set. The filed count is kept in the fixture's
`provenance.filedCount`; acceptance is the drop on the delivered branch.

- **`19 → 17`** flagged files. Two removals, both verifiable in this image.
- `God Object` falls `25 → 23` as the expected co-benefit; no sibling is itself
  flagged.

## What actually moved the number

Both removals were minted one declaration over the ceiling by #2005's split of
the 106-declaration `test/dependency-existence-check.test.py`: each carried 21
parser declarations (one class line, the interval-reset `setUp`/`tearDown`, the
scenario helpers and the tests). The class contract moved into a new non-test
module and whole `def test_*` bodies moved verbatim, so every module lands
`<= 15`:

| Module                                       | before | after | holds                                            |
| -------------------------------------------- | ------ | ----- | ------------------------------------------------ |
| `test_adapter_extraction.py`                 | 21     | 7     | Python/JS/Go scenarios                           |
| `test_adapter_extraction_jvm_dotnet.py`      | —      | 4     | JVM/.NET scenarios                               |
| `test_adapter_extraction_systems_dynamic.py` | —      | 8     | Rust/C++/Ruby/PHP/Swift/Dart                     |
| `test_registry_transport.py`                 | 21     | 5     | URL/maven/normalization/404                      |
| `test_registry_transport_cache.py`           | —      | 13    | retry/network/cache/rate-limit                   |
| `test_registry_transport_registries.py`      | —      | 3     | packagist/nuget                                  |
| `_bases.py` (new, shared)                    | —      | 8     | `AdapterExtractionBase` + `RegistryIntervalBase` |

The preserved surface is pinned by
`test/vba-god-module-refactor-2006.test.mts`: the union of `def test_*` names is
exactly the original 16 (adapter) + 13 (registry), each once; the five nested
helpers (`flaky`, `boom`, `opener` ×3) land in the cache sibling; no scenario
module imports a sibling or the family it was split from; and the thin entry
imports every scenario class, so `python3 test/dependency-existence-check.test.py`
still runs 62 tests. `scripts/dependency-existence-check.py` is untouched.

## Split policy (what may be split in-gate)

A file may only be split here when the move is verifiable **in this image**: a
toolchain-free language (Python/Go/TS) whose suites the pipeline already runs, or
a module whose split keeps a pinned boundary contract intact. Everything else is
measured and deferred with a reason, never silently omitted:

- **No toolchain → deferred.** Sixteen `.rs` files under
  `cmd/cheasee-pi/embedded/docker/ui` (`stream.rs` 72, `retry.rs` 62,
  `rpc/client.rs` 57, `session.rs` 53, and the rest of the measured set) cannot
  be split: `which cargo/rustc` is empty, there is no Docker in-gate, and no
  workflow compiles that tree (its builder image needs `rust:1.99`).
- **COPY-set / served-contract boundary → deferred.** `server.py` (51
  declarations) is the codeflow bridge; moving code out of it changes the
  Dockerfile `COPY` set and the `_BRIDGE_JS`/`_UI_REWRITES` served contract
  pinned by `bridge.test.mts`, so it belongs to the change that owns that guard.
- **Renaming or re-homing code into a non-scored extension to dodge the metric
  is rejected.** The oracle guards `reducedBy` against non-code paths, matching
  #2004/#2005.

## Deliberately not done

- **The 16 Rust UI files and `server.py`.** Still flagged, recorded in the
  fixture's `deferred` with a reason each; the accounting invariant
  `before.vbaGodModuleCount === reducedBy.length + Σ deferred files` (`19 = 2 + 17`)
  keeps the ledger closed, and `after.vbaGodModuleCount` equals the deferred
  count, so no leftover flag can be dropped silently.
- The `Architecture Issues` categories from the same analysis share overlapping
  file sets (Large Files, Highly Coupled, High Complexity, God Object, Long
  File), so per-issue file isolation is best-effort, not disjoint — as the
  issue's own context states.

## Risk

The predicate is derived from the external pinned analyzer `b0e82d1`; if the
CodeFlow checkout is re-pinned, the mirror and this record must be re-derived
(same contract as `coupling-2002.md`, `complexity-2003.md`,
`god-object-2004.md` and `long-file-2005.md`).

The exact set, the measured envelope and the guards are pinned in
`test/fixtures/vba-god-module-baseline.json`, asserted per sibling by
`test/vba-god-module-refactor-2006.test.mts` and replayed by
`test/codeflow-run-analysis.test.mts` (`vba god module metric oracle (issue #2006)`).
