# VBA-god-module reduction record (#2036 — `VBA God Module`)

The issue re-files the anti-pattern CodeFlow flagged on #2006: the pinned
analyzer counts files whose parser declaration count exceeds a fixed ceiling and
labels the anti-pattern `VBA God Module`. This record notes the second, narrower
filed set, the parser-mode split that decides which files are counted, the
measured drop, and what was deliberately left alone. The register and the layout
follow `vba-god-module-2006.md`, the first record for this metric.

## The metric

`index.html` `detectPatterns` (pinned analyzer ref below) emits the pattern as
the _same_ predicate behind `God Object`, at a higher ceiling:

```js
var vbaGodFiles = files.filter(function (f) {
	return f.isCode !== false && f.functions && f.functions.length > 20;
});
```

The count is the parser's, and the analyzer picks one of two parsers per file:

1. **`.js/.jsx/.ts/.tsx/.mjs/.cjs/.vue/.svelte` → `acorn-babel`** when the
   served UI has loaded `vendor/acorn` and `vendor/babel`. Babel strips the
   TypeScript/JSX, acorn parses the result, and the AST walk counts
   `FunctionDeclaration`, `const f = () =>`/`= function`, object-literal method
   shorthands and arrow properties. A mock's 28 no-op stubs are 28 declarations.
2. **Everything else, and the JS/TS branch when acorn is undefined →
   `heuristic-regex`.** The codeflow `run-analysis.mjs` sandbox sets
   `acorn: undefined`, so the headless runner never sees the object-literal
   methods. Its flagged set is the same four `.pi/extensions` files smaller.

The browser export that filed this issue ran the `acorn-babel` branch
(`totalFunctions` 4975 on the filed snapshot). The in-gate oracle for the
sibling metrics measures the regex branch, so the four TS/JS flags the issue
cites are invisible to it — this record keeps the acorn-babel measurement and
guards the split structurally instead.

Three consequences drive this change, unchanged from #2006:

- **The ceiling is strict.** 20 declarations is not flagged; 21 is, and a split
  only moves the metric when every sibling lands `<= 20`. This change targets
  `<= 15` so no sibling mints a `God Object` regression.
- **`VBA God Module` is a strict subset of `God Object`** (`> 15`, same
  predicate), so the drop here shows up as a `God Object` co-benefit.
- **Only code extensions are scored.** `.mts`, `.json` and `.md` are absent from
  `codeExts`, so the mirror, this oracle, the fixture and this record can never
  be reduction sources.

## Reproduction

```bash
git clone --depth 1 https://github.com/braedonsaunders/codeflow /tmp/codeflow-ui
# the clone head is already the pinned ref b0e82d127fc4990f571ebc6da6c5d9af2591aaa1

for ref in c89a4d276b8847e6f5e70a3857e21b86a69fc50e <delivered-tree>; do
  rm -rf /tmp/src /tmp/out && mkdir -p /tmp/src /tmp/out
  git archive "$ref" | tar -x -C /tmp/src
  node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs \
       /tmp/src /tmp/codeflow-ui /tmp/out
done
```

`run-analysis.mjs` alone leaves acorn/Babel undefined and measures the regex
branch. To measure the branch the browser used — the branch behind the filed
25-file set — load the checkout's vendored parsers into the analyzer context
(`card/lib/analyzer.js`): `Babel: require("../../vendor/babel/babel.min.js")`,
`acorn: require("../../vendor/acorn/acorn.min.js")`, and
`codeGeneration: { strings: true, wasm: false }`. That reproduction returns the
issue's filed counts exactly (harness-fixtures 37, config-ui 36, normalize 22,
debug 32, mock-pi 93, run-analysis.mjs 21). The metric is
`report.json` → `patterns` → the entry named `VBA God Module` → `.files.length`.

`before` is `origin/main` (`c89a4d27`); `after` is the code tree of this branch.
The artifacts that follow it are the ten `.ts` siblings plus `.json`/`.mts`/`.md`
records — the `.ts` siblings are scored and land `<= 15`, the rest are never
counted — so the delivered tree re-measures the same flagged set.

## Before / after (pinned analyzer, acorn-babel branch)

| Ref           | commit     | files | VBA God Module | God Object | functions |
| ------------- | ---------- | ----- | -------------- | ---------- | --------- |
| `origin/main` | `c89a4d27` | 956   | 25             | 36         | 4244      |
| this branch   | working    | 966   | 21             | 32         | 4241      |

The issue was filed with **25** files at `analyzedAt` 1791804971015; that
snapshot predates #2006 (the two Python test modules still counted 21 each) and
#2057. The immutable base re-measures **25** as well, but with those Python
modules already split and two files the issue did not cite
(`disk_space_test.go`, `fp-filter.js`) newly over the ceiling.

- **`25 → 21`** flagged files: the four `.pi/extensions` modules the issue cites
  drop under the ceiling, each via verbatim moves into siblings of `<= 15`.
- `God Object` falls **36 → 32** as the expected co-benefit; no sibling is itself
  flagged.

## What actually moved the number

Four families were split by responsibility; whole cohesive blocks move verbatim
and each reduced module re-exports its public surface, so no importer changed:

| Module                                                  | before | siblings landed                                                                                                 |
| ------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `.pi/extensions/agent-harness/test/harness-fixtures.ts` | 37     | `harness-api-stubs.ts` (command/flag/tool stubs), `harness-api-stubs-session.ts` (session/model/provider stubs) |
| `.pi/extensions/caveman/test/config-ui.test.ts`         | 36     | `config-ui-dialog.test.ts` (dialog suite), `config-ui-test-theme.ts` (sentinel theme mock)                      |
| `.pi/extensions/supervisor/event/adapter/normalize.ts`  | 22     | `normalize-types.ts`, `normalize-table-core.ts` (10 extractors), `normalize-table-deltas.ts` (6 extractors)     |
| `.pi/extensions/supervisor/lib/debug.ts`                | 32     | `debug-format.ts`, `debug-sanitize.ts`, `debug-logger.ts` (factory)                                             |

The preserved surface is pinned by `test/vba-god-module-refactor-2036.test.mts`:
the four modules still export their public symbols, the moved declarations live
in the siblings, and `npm test` runs the same suites (the dialog suite simply
runs from its new file). `test/codeflow-run-analysis.test.mts` replays the
recorded envelope.

## Deferred (measured, never split here)

- **The 16 `.rs` files** under `cmd/cheasee-pi/embedded/docker/ui`: no Rust
  toolchain in the pipeline image (`which cargo/rustc` is empty) and no Docker
  in-gate, so a split under that tree could not be compiled or tested before
  landing (#2002–#2006 precedent).
- **`run-analysis.mjs`** (21): the embedded headless analyzer; a split adds an
  `.mjs` sibling the codeflow Dockerfile `COPY` set, the `//go:embed embedded`
  set and the Go asset/run tests must own together.
- **`server.py`** (51): the codeflow bridge; moving code out changes the
  Dockerfile `COPY` set and the `_BRIDGE_JS`/`_UI_REWRITES` served contract
  pinned by the shim tests (#2006 reason).
- **`mock-pi.ts`** (93): one `ExtensionScore` mock whose whole surface is
  object-literal stubs; every sibling `<= 15` needs roughly eight section
  modules. Deferred to its own recorded change (#2004 precedent for the
  106-declaration suite).

The fixture's `deferred` records each with a reason; the accounting invariant
`before.vbaGodModuleCount === reducedBy.length + Σ deferred files` (`25 =
4 + 21`) keeps the ledger closed, and `after.vbaGodModuleCount` equals the
deferred count, so no leftover flag can be dropped silently. Two of the deferred
files (`disk_space_test.go`, `fp-filter.js`) are not cited by this issue; they
are recorded so the ledger balances.

## Risk

The predicate and the acorn-babel branch are derived from the external pinned
analyzer `b0e82d1`; if the CodeFlow checkout is re-pinned, this record and its
fixture must be re-derived (same contract as `god-object-2004.md` and
`vba-god-module-2006.md`).

The exact set, the measured envelope and the guards are pinned in
`test/fixtures/vba-god-module-baseline-2036.json`, asserted per family by
`test/vba-god-module-refactor-2036.test.mts` and replayed by
`test/codeflow-run-analysis.test.mts` (`vba god module metric oracle (issue #2036)`).
