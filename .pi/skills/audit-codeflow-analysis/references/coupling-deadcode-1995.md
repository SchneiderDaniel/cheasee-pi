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
analyzed at all. That is why the facade exports are preserved (below) and why
the real lever is a scanner phantom, not import breadth.

## Before / after (pinned analyzer, same snapshot method)

| Ref | files | functions | connections | ratio | coupling | dead | deadCode |
|-----|-------|-----------|-------------|-------|----------|------|----------|
| `origin/main` | 723 | 3508 | 3493 | 4.8313 | 3.663 | 45 | 1.283 |
| this branch | 724 | 3505 | 3170 | 4.3785 | 2.757 | 42 | 1.198 |

- ratio `4.8313 → 4.3785` (−0.4528), coupling `3.663 → 2.757` (−0.906 points),
  dead-code `1.283 → 1.198` (−0.085 points). (The branch file count is one
  higher because this record ships with the change.)
- Attribution: 321 of the 323 fewer connections are the `catalog.go` phantom
  (below); the remaining 2 come from dropped unused imports in
  `render-helpers.ts` / a pipeline integration test. The 3 fewer functions are
  the three unused ambient declarations removed below. No score-formula or
  detector configuration was touched.

### The `catalog.go` phantom (321 connections)

`func modelChoice(...) (def string, models []string)` named its results `def` and
`models`, which no statement in the body ever assigns or reads. The heuristic
scanner reads a bare word after `def` as a definition, so it invented a function
named `string` in `catalog.go`; every repository file that mentions the word
`string` then became a caller. Removing the unused named results (idiomatic Go —
the results are unnamed in the return statements) deletes the phantom and its 321
false edges. Mechanism recorded as row 10 of `known-false-positives.md`.

## Dead-code candidate verdicts

The pinned analyzer reports `dead: 45` before this change and `dead: 42` after
(the issue's live report saw 24 candidates over a different file set with the
sidecar's parser; this list is the full headless set). Each candidate was checked
for (a) the symbol used as a value passed by reference, (b) a trait/`impl`/`dyn`
or default-export dispatch, and (c) a `wire()`/framework seam, per row 8 of
`known-false-positives.md`.

**VALID and removed — 3 candidates.** `.pi/extensions/lib/proper-lockfile-ambient.ts`
declared `lockSync` / `unlockSync` / `checkSync` for the `proper-lockfile`
module. `rg` over the whole worktree finds no reference; `ensureVenv.ts` imports
the module but uses only the async API. Removing the three unreferenced ambient
declarations is a type-only change (no runtime body) and `npm run tsc:extensions`
stays green with them gone.

**INVALID — 42 candidates.** Every remaining entry is reached indirectly; the
lowercase `refs` count is the number of occurrences outside the declaration.

| Symbol | Location | Verdict | Row-8 disproof | First reference |
|--------|----------|---------|----------------|-----------------|
| `askUser` | .pi/extensions/ask-user/index.ts:135 | INVALID | referenced from 18 site(s) outside the declaration (row 8) | `.pi/extensions/ask-user/test/ask-user.test.mts:34 — import askUser, { successResult } from "../index.ts";` |
| `setSupervisorIssueData` | .pi/extensions/context-info/index.ts:87 | INVALID | referenced from 24 site(s) outside the declaration (row 8) | `.pi/extensions/context-info/README.md:133 — Exported setSupervisorIssueData/clearSupervisorIssueData` |
| `clearSupervisorIssueData` | .pi/extensions/context-info/index.ts:106 | INVALID | referenced from 20 site(s) outside the declaration (row 8) | `.pi/extensions/context-info/README.md:133 — Exported setSupervisorIssueData/clearSupervisorIssueData` |
| `unlock` | .pi/extensions/lib/proper-lockfile-ambient.ts:42 | INVALID | referenced from 6 site(s) outside the declaration (row 8) | `.pi/extensions/context-info/test/footer-config.test.mts:897 — unlock icon when trustStatus="untrusted"` |
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
