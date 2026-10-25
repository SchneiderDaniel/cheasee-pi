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
   shorthands and arrow properties. A mock's no-op stubs are declarations.
2. **Everything else, and the JS/TS branch when acorn is undefined →
   `heuristic-regex`.** The codeflow `run-analysis.mjs` sandbox sets
   `acorn: undefined`, so the headless runner never sees the object-literal
   methods. Python counts every `def` (any indent) and `class`; Go/Rust use the
   shared `RULES` regexes.

The browser export that filed this issue ran the `acorn-babel` branch
(`totalFunctions` 4975 on the filed snapshot), so this record measures that
branch. Two consequences drive the change:

- **The ceiling is strict.** 20 declarations is not flagged; 21 is, and a split
  only moves the metric when every sibling lands `<= 20`.
- **`VBA God Module` is a strict subset of `God Object`** (`> 15`, same
  predicate), so the drop here shows up as a `God Object` co-benefit. The ten
  Rust test siblings that land at 16–20 are cohesive test groups split out of a
  `God Object` parent, so the tree-wide `God Object` count still falls
  (`36 → 31`); the oracle asserts that count against the live base rather than
  demanding every sibling be `<= 15`.

## The mirror (reproducible in-gate)

`test/fixtures/acorn-babel-mirror.mts` ports the acorn branch's
`Parser.extractJSFunctions`: it strips TS with node's `stripTypeScriptTypes`
(the same strip step as Babel's typescript preset, positions preserved), parses
with acorn, walks the AST with the analyzer's four `addFn` cases and
deduplicates by `name@line`, falling back to the analyzer's regex extractor when
the parse throws. `test/fixtures/function-count-mirror.mts` covers the
regex/Python/Go/Rust branch.

The oracle re-runs that detector over **both trees** —
`test/vba-god-module-refactor-2036.test.mts` unpacks the pinned base commit and
asserts that (a) every cited module was over the ceiling there and is under it
in the delivered tree, (b) the base's flagged set is exactly the reduced modules
plus the recorded uncited leftovers, (c) no sibling re-enters the anti-pattern
set, (d) the delivered tree's `VBA God Module` count equals the deferral list,
and (e) `God Object` did not grow — so a stale count, a module that was never
really flagged, or a regression that leaves a split module over the ceiling
cannot pass. The mirror reproduces the filed counts exactly
(`harness-fixtures` 37, `config-ui` 36, `normalize` 22, `debug` 32, `mock-pi`
93, `run-analysis.mjs` 21, `server.py` 51, `retry.rs` 62, `stream.rs` 72).

## Reproduction

```bash
git clone --depth 1 https://github.com/braedonsaunders/codeflow /tmp/codeflow-ui
# the clone head is already the pinned ref b0e82d127fc4990f571ebc6da6c5d9af2591aaa1

for ref in 463f382cf558566fa537ade5bbed25403cd3fd31 <delivered-tree>; do
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
`codeGeneration: { strings: false, wasm: false }`. That reproduction returns the
issue's filed counts exactly. The metric is `report.json` → `patterns` → the
entry named `VBA God Module` → `.files.length`.

`before` is `origin/main` (`463f382c`); `after` is the code tree of this branch.
The artifacts that follow it include the 58 scored siblings from this refactor,
five scored siblings from #2034, and `.json`/`.mts` records — the siblings are
scored and under `20`, the records are never counted.

## Before / after (pinned detector, acorn-babel branch)

| Ref           | commit     | code files | VBA God Module | God Object |
| ------------- | ---------- | ---------- | -------------- | ---------- |
| `origin/main` | `463f382c` | 727        | 25             | 36         |
| this branch   | working    | 790        | 1              | 28         |

`code files` is the tracked-file count whose extension the analyzer scores (the
pinned `codeExts`), measured in-gate from `git ls-tree`/`git ls-files`; the
external analyzer's own `summary.totalFiles` also counts non-code files, so it is
larger for both refs. The delivered tree has 58 scored siblings from this refactor
plus five scored siblings from #2034, which merged into main after the pinned base;
no scored files were deleted.

The issue was filed with **25** files at `analyzedAt` 1791804971015; that
snapshot predates #2006 (the two Python test modules still counted 21 each) and
#2057. The pinned base re-measures **25** as well, but with those Python modules
already split and two files the issue did not cite (`disk_space_test.go`,
`fp-filter.js`) newly over the ceiling.

- **`25 → 1`** flagged file: all 23 cited modules that the pinned base flags
  drop under the ceiling, each via verbatim moves into siblings of the same module
  tree (the strings skipper is inlined). #2034 also split the uncited `disk_space_test.go`.
- The remaining `fp-filter.js` flag is the **uncited leftover** recorded below.
- The 2 cited Python test modules (`test_adapter_extraction.py`,
  `test_registry_transport.py`) were already under the base ceiling — #2006
  split them — and are recorded as `alreadyUnder`, so all 25 filed paths stay
  accounted for.
- `God Object` falls as the expected co-benefit (`36 → 28` in the delivered tree).

## What actually moved the number

Twenty-three families were split by responsibility; whole cohesive blocks move
verbatim and each reduced module keeps its public surface (spread/merge/re-export
barrels in TS, `mod`/`pub use` in Rust, sibling imports in Python), so no
importer changed:

| Module                                                  | before | siblings landed                                                                                                                          |
| ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `.pi/extensions/agent-harness/test/harness-fixtures.ts` | 37     | `harness-api-stubs.ts` (command/flag/tool stubs), `harness-api-stubs-session.ts` (session/model/provider stubs)                          |
| `.pi/extensions/caveman/test/config-ui.test.ts`         | 36     | `config-ui-dialog.test.ts` (dialog suite), `config-ui-test-theme.ts` (sentinel theme mock)                                               |
| `.pi/extensions/supervisor/event/adapter/normalize.ts`  | 22     | `normalize-types.ts`, `normalize-table-core.ts` (10 extractors), `normalize-table-deltas.ts` (6 extractors)                              |
| `.pi/extensions/supervisor/lib/debug.ts`                | 32     | `debug-format.ts`, `debug-sanitize.ts`, `debug-logger.ts` (logger factory)                                                               |
| `.pi/extensions/supervisor/test/helpers/mock-pi.ts`     | 93     | 12 per-responsibility stub groups (theme, UI core/editor/theme-ctx, session core/tree, model, API commands/tools/runtime)                |
| `cmd/.../codeflow/run-analysis.mjs`                     | 21     | none — the single-use `skipString` helper is inlined into `matchBrace`, taking it to 20                                                  |
| `cmd/.../codeflow/server.py`                            | 51     | `config.py`, `report_store.py`, `analysis_run.py`, `repo_identity.py`, `ui_rewrites.py` (the Dockerfile `COPY`/`py_compile` set follows) |
| `ui/src/auth.rs`                                        | 27     | `auth/tests.rs`                                                                                                                          |
| `ui/src/controls.rs`                                    | 28     | `controls/tests.rs`                                                                                                                      |
| `ui/src/main.rs`                                        | 27     | `src/tests.rs` (axum/SSR routing tests)                                                                                                  |
| `ui/src/pi_process.rs`                                  | 34     | `pi_process/tests.rs`                                                                                                                    |
| `ui/src/retry.rs`                                       | 62     | `retry/wiring.rs` (the wiring/socket adapter), `retry/tests.rs`, `retry/tests_wiring.rs`                                                 |
| `ui/src/rpc/client.rs`                                  | 56     | `rpc/client/tests.rs`, `rpc/client/tests_delivery.rs`                                                                                    |
| `ui/src/rpc/framing.rs`                                 | 30     | `rpc/framing/tests.rs`, `rpc/framing/tests_reader.rs`                                                                                    |
| `ui/src/session.rs`                                     | 53     | `session/relay.rs` (relay loop + frame translation), `session/tests.rs`                                                                  |
| `ui/src/sessions_store.rs`                              | 49     | `sessions_store/replay.rs`, `sessions_store/tests.rs`, `sessions_store/tests_replay.rs`                                                  |
| `ui/src/stream.rs`                                      | 72     | `stream/assembler.rs`, `stream/assembler/replay.rs`, `stream/chat.rs`, `stream/rows.rs`, `stream/tests.rs`, `stream/tests_rows.rs`       |
| `ui/src/subscribe.rs`                                   | 30     | `subscribe/tests.rs`                                                                                                                     |
| `ui/tests/event_widgets.rs`                             | 25     | `event_widgets/banners.rs` (reached through `#[path]`)                                                                                   |
| `ui/tests/extension_ui.rs`                              | 41     | `extension_ui/chrome.rs`, `extension_ui/state.rs`                                                                                        |
| `ui/tests/reconnect.rs`                                 | 26     | `reconnect/journey.rs`                                                                                                                   |
| `ui/tests/rpc_protocol.rs`                              | 40     | `rpc_protocol/codec.rs`, `rpc_protocol/events.rs`, `rpc_protocol/session.rs`                                                             |
| `ui/tests/stream_assembly.rs`                           | 24     | `stream_assembly/replay.rs`                                                                                                              |

The preserved surface is pinned by `test/vba-god-module-refactor-2036.test.mts`:
every reduced module still exports its public symbols, the moved declarations
live in the siblings (each declared by its parent module or imported by
`server.py`), a per-family declaration total is conserved on the Rust and Python
side, and `npm test` runs the same suites.

## Verification of the Rust and Python splits

The pipeline image has no C linker, so `cargo check` cannot run even though a
`rustc` toolchain is present. The split was verified instead by:

- a module-tree resolver over every `mod` declaration from `src/lib.rs`,
  `src/main.rs` and each `tests/*.rs` crate root (it caught three stale inner
  `mod` declarations and eight integration-test children that needed `#[path]`);
- `rustfmt --check` over those crate roots, which parses every reachable module;
- `rust-analyzer diagnostics` over the crate in both trees (the tree with
  `default = ["ssr"]` temporarily flipped, then restored) — after mapping each
  sibling to the module it was split from, the delivered tree reports the same
  error classes as the pinned base on the equivalent modules (only `E0277`
  `Serialize not satisfied` / `E0282` / macro `SyntaxError` artifacts from
  unbuilt proc-macro derives), and no unresolved-module, unresolved-import or
  privacy error on either side, so the split introduced no new diagnostic;
- `go test ./cmd/cheasee-pi/` for the codeflow shim (it compiles every module
  with `py_compile` and drives the served contract), plus the Python suite. Its
  `TestUI_WSClientLifecycleWiring` layout gate now reads `retry.rs` and
  `retry/wiring.rs` concatenated: the wiring declarations moved to the sibling,
  and `mod wiring;` compiles both into the same targets, so a deletion in
  either file still fails the gate.

The first full `cargo check`/build remains the browser (Docker) build.

## Deferred (measured, never split here)

No cited module is deferred. The delivered tree has one remaining flag for a
file the issue does **not** cite (`fp-filter.js`); it belongs to the long-file /
anti-pattern issues that share the same file set. `disk_space_test.go`, which was
also an uncited flag at the pinned base, was split by #2034 after that base.

The fixture records both paths: `deferred` holds the still-flagged `fp-filter.js`,
and `baseAdvance.resolvedFiles` records the `disk_space_test.go` reduction in the
advanced main branch. Thus the pinned-base accounting is
`reducedBy` (23) + `deferred` (1) + `baseAdvance.resolvedFiles` (1) = 25; on the
delivered tree, `after.vbaGodModuleCount` equals the single deferred flag.

## Risk

The predicate and the acorn-babel branch are derived from the external pinned
analyzer `b0e82d1`; if the CodeFlow checkout is re-pinned, this record, its
mirror and its fixture must be re-derived (same contract as `god-object-2004.md`
and `vba-god-module-2006.md`).

The Rust and Python splits carry no in-gate type-check (no linker, no Rust
toolchain component set for `cargo build`): syntax, the module tree and
rust-analyzer's diagnostic parity with the base are covered, plus the Python
`py_compile` gate, while the first full compile lands in the Docker build.

The exact set, the measured envelope and the guards are pinned in
`test/fixtures/vba-god-module-baseline-2036.json`, asserted per family by
`test/vba-god-module-refactor-2036.test.mts` and replayed by
`test/codeflow-run-analysis.test.mts` (`vba god module metric oracle (issue #2036)`).
