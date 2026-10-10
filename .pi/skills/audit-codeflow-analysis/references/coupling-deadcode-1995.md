# Coupling / dead-code verification record (#1995)

Chore #1995 reduces the two live `calcHealth` terms this repository actually
controls: coupling and dead code. This file is the verification record: the
pinned-analyzer calibration, the reproduced before/after numbers, and the
per-candidate dead-code verdicts. It is the artifact the audit asked for in
place of the previous "stub analyzer only, no measurement" claim.

## Pinned analyzer and how to reproduce

The score inputs come from the pinned CodeFlow UI, not from this repository:

- ref `b0e82d127fc4990f571ebc6da6c5d9af2591aaa1` of
  `https://github.com/braedonsaunders/codeflow`, the same ref
  `cmd/cheasee-pi/embedded/docker/codeflow/Dockerfile` pins for the sidecar.
- `run-analysis.mjs` reuses that checkout's own analyzer and now prints the
  analyzer stats and the derived terms, so a measurement is reproducible
  without the browser UI:

```bash
git clone --depth 1 https://github.com/braedonsaunders/codeflow /tmp/codeflow-ui
git -C /tmp/codeflow-ui fetch --depth 1 origin b0e82d127fc4990f571ebc6da6c5d9af2591aaa1
git -C /tmp/codeflow-ui checkout --detach FETCH_HEAD

for ref in origin/main HEAD; do
  rm -rf /tmp/src && mkdir -p /tmp/src
  git archive "$ref" | tar -x -C /tmp/src
  node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs \
    /tmp/src /tmp/codeflow-ui /tmp/out
done
```

`git archive` snapshots the committed tree, so the two refs are measured with
one analyzer on the same file set. The envelope's `stats` and `terms` are the
measurement; the report artifacts are unaffected.

> Note on the issue's numbers: the live report `local/workspace-f4048b9b`
> (1026 files, 5006 dependencies, ratio 4.879, 24 unused) was produced by the
> sidecar over the live workspace file set (which includes untracked trees),
> not over the committed `git archive` tree, and is therefore not the same unit
> as the numbers below (for example `.mts` is absent from the pinned analyzer's
> extension lists, so extension test files are not counted). The before/after
> below are both on the pinned analyzer over the committed tree and are
> comparable to each other; that is what makes the delta attributable.

## Connection unit (pinned by experiment)

`data.stats.connections` is **not** an import-statement or imported-binding
count, despite the UI label "Dependencies". It is built in `buildAnalysisData`
(`index.html`, pinned ref) from two sources only:

- resolved call/identifier references: one edge
  `(definitionFile, referencingFile, functionName)` per pair, merged across
  repeats (`conns.push` at the call-resolution loop), and
- one edge per markdown cross-link (`conns.push` at the link-resolution loop).

Because the pinned writer has no `Babel`/`acorn`/`TreeSitter` in the headless vm,
source files are parsed in `heuristic-regex` mode: `Parser.findCalls` counts each
identifier occurrence of a known function name, and `resolveCallDefinitions`
maps it to the definition file. An `import { x } from "…"` therefore contributes
one edge for `x` even when `x` is never called.

Probe (three hypotheses: import statements / imported bindings / call sites):

```
a.ts: export function alpha(){}  export function gamma(){}
b.ts: import { alpha, gamma } from "./a";  export function beta(){ return alpha()+gamma(); }
c.ts: import { alpha } from "./a";
      import { gamma } from "./a";          // 2 statements, 2 bindings, 1 call
      export function cc(){ return alpha(); }
```

Observed: `b.ts = 2` (`alpha`, `gamma`) and `c.ts = 2` (`alpha`, `gamma`).
Import statements predict `b=1, c=2`; call sites predict `b=2, c=1`; imported
bindings predict `b=2, c=2`. The observed `b=2, c=2` pins the unit to imported
bindings / resolved cross-file identifier references.

Consequence for the chore: the Python re-export barrels and extension tests are
import statements; only the *referencing* side matters, and `.mts` files are not
analyzed at all. That is why the facade exports are preserved (below), and why
the reducible surface is narrow: a repo-wide sweep for genuinely-unused imports
(`tsc --noUnusedLocals` over `.pi/tsconfig.json`, an AST scan of the `.js`/`.mjs`
files, and a Python import audit) leaves exactly two unused cross-file function
imports, removed below. The dominant movement in the `calcHealth` coupling term
is consequently scanner-artifact suppression, which the attribution section below
reports separately and does **not** count as coupling reduction.

## Before / after (pinned analyzer, same snapshot method)

| Ref | files | functions | connections | ratio | coupling | dead | deadCode |
|-----|-------|-----------|-------------|-------|----------|------|----------|
| `origin/main` | 724 | 3522 | 3503 | 4.8384 | 3.677 | 45 | 1.278 |
| this branch | 725 | 3518 | 3179 | 4.3848 | 2.770 | 41 | 1.165 |

- ratio `4.8384 → 4.3848` (−0.4536), coupling `3.677 → 2.770` (−0.907 points),
  dead-code `1.278 → 1.165` (−0.113 points). (The branch file count is one
  higher because this record ships with the change.)
- **Attribution is split by measurement, not assertion.** A third tree `B′` —
  this branch with only `cmd/cheasee-pi/catalog.go` restored to `origin/main` —
  isolates every change except the Go named-result cleanup. Same pinned
  analyzer, same `git archive` snapshot method:

| Tree | files | functions | connections | ratio | coupling |
|------|-------|-----------|-------------|-------|----------|
| `A` `origin/main` | 724 | 3522 | 3503 | 4.8384 | 3.677 |
| `B′` branch, `catalog.go` reverted | 725 | 3519 | 3501 | 4.8290 | 3.658 |
| `B` this branch | 725 | 3518 | 3179 | 4.3848 | 2.770 |

  - **Real dependency-edge reduction — `A → B′`, −2 connections.** Dropping two
    genuinely-unused cross-file function imports from analyzed code:
    `extractTextFromContent` from `agent-session-runner.ts` and
    `getBuiltinToolLabels` from `render-helpers.ts`. (`workflow.ts`'s dropped
    `ParseResult` and `state-checkpoint.ts`'s dropped `dirname` remove no
    connection: a type name and a `node:` builtin are not repo functions. The
    `.mts` test-import drops are hygiene only — `.mts` is absent from the
    pinned analyzer's code extensions, so it contributes no edge.)
  - **Scanner-artifact suppression — `B′ → B`, −322 connections.** This is the
    `catalog.go` phantom below. It is **not counted as coupling reduction** and
    is listed only to keep the total reconcilable. It is a legitimate Go
    cleanup whose *metric* effect is artifact removal, filed against the
    detector-false-positive track (row 10 of `known-false-positives.md`), not
    against this chore.
  - Net connection movement `−324 = −2 real + −322 artifact`; file-count +1 is
    this record shipping with the change. No score-formula or detector
    configuration was touched, so `calcHealth` is unchanged.

### The `catalog.go` phantom (322 connections, not coupling work)

`func modelChoice(...) (def string, models []string)` named its results `def` and
`models`, which no statement in the body ever assigns or reads. The heuristic
scanner reads a bare word after `def` as a definition, so it invented a function
named `string` in `catalog.go`; every repository file that mentions the word
`string` then became a caller. Removing the unused named results (idiomatic Go —
the results are unnamed in the return statements) deletes the phantom and its 322
false edges. Mechanism recorded as row 10 of `known-false-positives.md`.

This is a detector artifact: the 322 edges never represented a dependency. The
chore therefore reports them separately from the −2 real dependency edges and
does not rely on them to claim the coupling term moved.

## Dead-code candidate verdicts

The pinned analyzer reports `dead: 45` before this change and `dead: 41` after.
Every candidate was checked for (a) the symbol used as a value passed by
reference, (b) a trait/`impl`/`dyn` or default-export dispatch, and (c) a
`wire()`/framework seam, per row 8 of `known-false-positives.md`.

**Attribution.** The four removals below are functions the *headless* analyzer
extracts but no code references; they are not among the live report's 24 (which
are all INVALID). The live `Unused Functions` numerator therefore stays 24 and
the live dead-code term is effectively unchanged — the reproducible improvement
is the headless `dead` count, 45 → 41. This is why the issue's own estimate for
the dead-code lever is ≈ 0.5 and why no live candidate was force-removed.

### The issue's live-run candidates (24), with individual verdicts

The `local/workspace-f4048b9b` report is captured verbatim at
`ignore/codeflow-report.md` (repo label `local/workspace-f4048b9b`, analyzed
`2026-10-09T19:52:19`, 1026 files / 4890 functions / 5006 connections — the same
numbers the issue cites). Its `## Unused Functions (24)` section names all 24
candidates; each is given an individual row-8 verdict below. Every one is
reached indirectly, so none qualifies for removal and none was removed.

| # | Symbol | Location | Verdict | Row-8 disproof (evidence) |
|---|--------|----------|---------|---------------------------|
| 1 | `defaultIsWritable` | `.pi/extensions/scrapling/browser-setup.ts:81` | INVALID | value passed by reference (`opts.isWritable ?? defaultIsWritable`, `:115`), invoked `:140` |
| 2 | `defaultFetch` | `.pi/skills/audit-codeflow-analysis/lib/codeflow-run.ts:64` | INVALID | callback seam (`opts.fetchFn ?? defaultFetch`, `:145`) |
| 3 | `defaultSleep` | `.pi/skills/audit-codeflow-analysis/lib/codeflow-run.ts:66` | INVALID | callback seam (`opts.sleepFn ?? defaultSleep`, `:146`) |
| 4 | `defaultFetch` | `.pi/skills/audit-codeflow-analysis/lib/fetch-report.ts:68` (live report `:70`) | INVALID | value passed by reference (`let fetchFn = defaultFetch`, `:91`; `fetchFn = fn ?? defaultFetch`, `:98`) |
| 5 | `defaultWriteFile` | `.pi/skills/audit-codeflow-analysis/lib/fetch-report.ts:78` (live report `:80`) | INVALID | value passed by reference (`let writeFileFn = defaultWriteFile`, `:92`; `writeFileFn = fn ?? defaultWriteFile`, `:103`) |
| 6 | `opened` | `cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:199` | INVALID | adapter method invoked by `wire()` (`retry.rs:274`) |
| 7 | `stable_elapsed` | `cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:211` | INVALID | adapter method invoked by `wire()` (`retry.rs:278`); pinned live by `TestUI_WSClientLifecycleWiring` |
| 8 | `transport_closed` | `cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:218` | INVALID | adapter method invoked by `wire()` (`retry.rs:285`) |
| 9 | `on_close` | `cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:236` | INVALID | `Socket` trait method (declared `:236`), impls `ws.rs:71` / `retry.rs:502`, driven by `wire()` |
| 10 | `is_open` | `cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:396` | INVALID | `Transport` impl (declared `:306`) used by the send policy |
| 11 | `send_text` | `cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:399` | INVALID | `Transport` impl (declared `:307`); live impl `main.rs:309` |
| 12 | `on_message` | `cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:499` | INVALID | test `Socket` impl (declared `:235`), exercised by the retry suite |
| 13 | `on_close` | `cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:502` | INVALID | test `Socket` impl (declared `:236`) |
| 14 | `reconnect_delay` | `cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:596` | INVALID | test method calling the free fn defined `retry.rs:430` |
| 15 | `read_cursor` | `cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:468` | INVALID | trait method (declared `subscribe.rs:109`), impl for `SessionStore` |
| 16 | `write_cursor` | `cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:472` | INVALID | trait method (declared `subscribe.rs:110`) |
| 17 | `read_cursor` | `cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:482` | INVALID | trait method (declared `subscribe.rs:109`) |
| 18 | `write_cursor` | `cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:486` | INVALID | trait method (declared `subscribe.rs:110`) |
| 19 | `read_cursor` | `cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:122` | INVALID | trait method; concrete impl `sessions_store.rs:370` |
| 20 | `write_cursor` | `cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:126` | INVALID | trait method; concrete impl `sessions_store.rs:378` |
| 21 | `read_cursor` | `cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:397` | INVALID | trait method; concrete impl `sessions_store.rs:370` |
| 22 | `write_cursor` | `cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:401` | INVALID | trait method; concrete impl `sessions_store.rs:378` |
| 23 | `on_message` | `cmd/cheasee-pi/embedded/docker/ui/src/ws.rs:60` | INVALID | `impl Socket for BrowserSocket`; callback installed by `wire()` |
| 24 | `on_close` | `cmd/cheasee-pi/embedded/docker/ui/src/ws.rs:71` | INVALID | `impl Socket for BrowserSocket`; callback installed by `wire()` |

24 of 24 INVALID. Each is reached by a callback seam, a trait/`impl` dispatch, or
a `wire()` adapter call that a call-site text search misses; none was removed.
The headless candidate list below flags the 19 Rust entries and
`defaultIsWritable` from this same set, so no live entry is left unexamined.

**VALID and removed — 4 candidates.** `.pi/extensions/lib/proper-lockfile-ambient.ts`
declared `lockSync` / `unlockSync` / `checkSync` / `unlock` for the
`proper-lockfile` module. `rg` over the whole worktree finds no reference for any
of them; `ensureVenv.ts` imports the module but uses only `lockfile.lock` (the
async `lock`), never the standalone `unlock`. The only textual hits for `unlock`
are a test-title string and an unrelated local variable, neither a reference
under the AST rule the repo uses for its own dead-import guard
(`test/extension-test-imports.test.mts`), so `unlock` is genuinely dead like the
three sync declarations. Removing the four unreferenced ambient declarations is
a type-only change (no runtime body) and `npm run tsc:extensions` stays green
with them gone.

**INVALID — 41 candidates.** Every remaining entry is reached indirectly; the
lowercase `refs` count is the number of occurrences outside the declaration.

| Symbol | Location | Verdict | Row-8 disproof | First reference |
|--------|----------|---------|----------------|-----------------|
| `askUser` | .pi/extensions/ask-user/index.ts:135 | INVALID | referenced from 18 site(s) outside the declaration (row 8) | `.pi/extensions/ask-user/test/ask-user.test.mts:34 — import askUser, { successResult } from "../index.ts";` |
| `setSupervisorIssueData` | .pi/extensions/context-info/index.ts:87 | INVALID | referenced from 24 site(s) outside the declaration (row 8) | `.pi/extensions/context-info/README.md:133 — Exported setSupervisorIssueData/clearSupervisorIssueData` |
| `clearSupervisorIssueData` | .pi/extensions/context-info/index.ts:106 | INVALID | referenced from 20 site(s) outside the declaration (row 8) | `.pi/extensions/context-info/README.md:133 — Exported setSupervisorIssueData/clearSupervisorIssueData` |
| `lspAuditor` | .pi/extensions/lsp-auditor/index.ts:20 | INVALID | referenced from 42 site(s) outside the declaration (row 8) | `.pi/extensions/lsp-auditor/README.md:62 — "lspAuditor": {` |
| `ponytailExtension` | .pi/extensions/ponytail/index.js:76 | INVALID | `export default` extension activation — dispatched by the pi runtime, not by name | `.pi/extensions/ponytail/index.js:76 — export default function` |
| `ripgrepSearch` | .pi/extensions/ripgrep-search/index.ts:230 | INVALID | referenced from 13 site(s) outside the declaration (row 8) | `.pi/extensions/ripgrep-search/README.md:55 — "ripgrepSearch": {` |
| `searches` | .pi/extensions/ripgrep-search/internal.ts:37 | INVALID | scanner phantom from a comment (`class/def searches`) — no declaration/body exists (row 10) | `.pi/extensions/ripgrep-search/internal.ts:37 — ast-grep) for class/def searches` |
| `defaultIsWritable` | .pi/extensions/scrapling/browser-setup.ts:81 | INVALID | value passed by reference (`opts.isWritable ?? defaultIsWritable`), row 8 callback seam | `.pi/extensions/scrapling/browser-setup.ts:115` |
| `structuralAnalyzer` | .pi/extensions/structural-analyzer/index.ts:27 | INVALID | referenced from 62 site(s) outside the declaration (row 8) | `.pi/extensions/structural-analyzer/test/directory-traversal.test.mts:19 — import structuralAnalyzer from "../index.ts";` |
| `classifyKillReason` | .pi/extensions/supervisor/agent/runner/budget.ts:28 | INVALID | referenced from 5 site(s) outside the declaration (row 8) | `.pi/extensions/supervisor/test/runner-split.test.mts:17 — budget exactly-once kill + classifyKillReason` |
| `renderWidgetFromDetails` | .pi/extensions/supervisor/session/widget.ts:54 | INVALID | referenced from 46 site(s) outside the declaration (row 8) | `.pi/extensions/supervisor/test/chat-progress.test.mts:12 — import { renderWidgetFromDetails }` |
| `dumpContextExtension` | .pi/extensions/zzz-dump-context/index.ts:182 | INVALID | `export default` extension activation — dispatched by the pi runtime, not by name | `.pi/extensions/zzz-dump-context/index.ts:182 — export default function` |
| `setFetchFactory` | .pi/skills/audit-codeflow-analysis/lib/fetch-report.ts:97 | INVALID | referenced from 11 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/test/codeflow-analysis.test.mts:38` |
| `setWriteFileFactory` | .pi/skills/audit-codeflow-analysis/lib/fetch-report.ts:102 | INVALID | referenced from 6 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/test/codeflow-analysis.test.mts:39` |
| `resetReportCache` | .pi/skills/audit-codeflow-analysis/lib/fetch-report.ts:107 | INVALID | referenced from 7 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/test/codeflow-analysis.test.mts:37` |
| `parseBestReport` | .pi/skills/audit-codeflow-analysis/lib/report.ts:334 | INVALID | referenced from 14 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/SKILL.md:127` |
| `dedupeIssues` | .pi/skills/audit-codeflow-analysis/lib/report.ts:368 | INVALID | referenced from 15 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/SKILL.md:204` |
| `reportUnparsedItems` | .pi/skills/audit-codeflow-analysis/lib/report.ts:405 | INVALID | referenced from 8 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/SKILL.md:229` |
| `reportSectionCoverage` | .pi/skills/audit-codeflow-analysis/lib/report.ts:451 | INVALID | referenced from 15 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/SKILL.md:211` |
| `classifyKnownNoise` | .pi/skills/audit-codeflow-analysis/lib/report.ts:538 | INVALID | referenced from 25 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/SKILL.md:196` |
| `classifyFinding` | .pi/skills/audit-codeflow-analysis/lib/report.ts:566 | INVALID | referenced from 35 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/SKILL.md:45` |
| `groupIssues` | .pi/skills/audit-codeflow-analysis/lib/report.ts:611 | INVALID | referenced from 15 site(s) outside the declaration (row 8) | `.pi/skills/audit-codeflow-analysis/SKILL.md:128` |
| `opened` | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:199 | INVALID | Rust trait method reached through `wire()`; name also appears in `.github/workflows/pr-welcome.yml:5` (`types: [opened]`) | cmd/cheasee-pi/embedded/docker/ui/src/ws.rs — `wire()` seam |
| `stable_elapsed` | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:211 | INVALID | Rust trait method reached through `wire()`; pinned live by `TestUI_WSClientLifecycleWiring` | cmd/cheasee-pi/embedded/docker/ui/src/ws.rs — `wire()` seam |
| `transport_closed` | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:218 | INVALID | Rust trait method reached through `wire()` | cmd/cheasee-pi/embedded/docker/ui/src/ws.rs — `wire()` seam |
| `on_close` | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:236 | INVALID | `fn on_close` declared in retry.rs, implemented/called from ws.rs:71 | cmd/cheasee-pi/embedded/docker/ui/src/ws.rs:71 |
| `is_open` | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:396 | INVALID | `fn is_open` implemented in ws.rs:81 (`impl Socket for BrowserSocket`) | cmd/cheasee-pi/embedded/docker/ui/src/ws.rs:81 |
| `send_text` | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:399 | INVALID | `async fn send_text` implemented in main.rs:309 | cmd/cheasee-pi/embedded/docker/ui/src/main.rs:309 |
| `on_message` | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:499 | INVALID | `fn on_message` implemented in ws.rs:60 | cmd/cheasee-pi/embedded/docker/ui/src/ws.rs:60 |
| `on_close` | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:502 | INVALID | `fn on_close` implemented in ws.rs:71 | cmd/cheasee-pi/embedded/docker/ui/src/ws.rs:71 |
| `reconnect_delay` | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:596 | INVALID | `fn reconnect_delay` defined at retry.rs:430 and called below | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:430 |
| `read_cursor` | cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:468 | INVALID | trait method implemented for `SessionStore`; declared in subscribe.rs:109 | cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:109 |
| `write_cursor` | cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:472 | INVALID | trait method implemented for `SessionStore`; declared in subscribe.rs:110 | cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:110 |
| `read_cursor` | cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:482 | INVALID | trait method implemented for `SessionStore`; declared in subscribe.rs:109 | cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:109 |
| `write_cursor` | cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:486 | INVALID | trait method implemented for `SessionStore`; declared in subscribe.rs:110 | cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:110 |
| `read_cursor` | cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:122 | INVALID | trait method defined in sessions_store.rs:370 and implemented here | cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:370 |
| `write_cursor` | cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:126 | INVALID | trait method defined in sessions_store.rs:378 | cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:378 |
| `read_cursor` | cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:397 | INVALID | trait method defined in sessions_store.rs:370 | cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:370 |
| `write_cursor` | cmd/cheasee-pi/embedded/docker/ui/src/subscribe.rs:401 | INVALID | trait method defined in sessions_store.rs:378 | cmd/cheasee-pi/embedded/docker/ui/src/sessions_store.rs:378 |
| `on_message` | cmd/cheasee-pi/embedded/docker/ui/src/ws.rs:60 | INVALID | `fn on_message` declared in retry.rs:235 | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:235 |
| `on_close` | cmd/cheasee-pi/embedded/docker/ui/src/ws.rs:71 | INVALID | `pub fn on_close` defined in retry.rs:65 | cmd/cheasee-pi/embedded/docker/ui/src/retry.rs:65 |

## Known dependency advisories (tracked, not a #1995 lever)

The pre-audit scan's two unknown-severity unmaintained-package advisories match
`cmd/cheasee-pi/embedded/docker/ui/Cargo.lock`:

- `paste` `1.0.15` (RUSTSEC-2024-0436) — `Cargo.lock:1310`.
- `proc-macro-error2` `2.0.1` (RUSTSEC-2026-0173) — `Cargo.lock:1392`.

Both are already recorded as accepted maintenance risk with the resolution path
(bump `leptos` once upstream drops them), no reachable replacement in the pinned
leptos 0.8 line, and no exploitable CVE established: `docs/sbom.md:60-68` and
`cmd/cheasee-pi/embedded/docker/ui/Cargo.toml:17-21`. #1995 changes no Rust
dependency and does not touch the lockfile, so it neither adds nor removes the
advisory; this note only points the follow-up at the existing record.
