# Complexity reduction record (#2033 — `286 High Complexity Files`)

The issue is filed from the CodeFlow `Architecture Issues` section: the pinned
analyzer titles that section with a count of files whose approximate cyclomatic
complexity exceeds a fixed ceiling. This file records what the metric actually
measures, the reproduction, the measured drop, the price paid in a neighbouring
metric, and what was deliberately left alone. The register and the layout follow
`complexity-2003.md`, the record for the sibling issue on the same metric.

## The metric

`index.html` scores every analyzed file with `calcComplexity` (pinned analyzer
ref `b0e82d1`):

```js
calcComplexity(content) {
  if (!content) return { score: 0, level: 'low' };
  let complexity = 1;
  for (const p of patterns) { const m = content.match(p); if (m) complexity += m.length; }
  let level = 'low';
  if (complexity > 30) level = 'critical';
  else if (complexity > 20) level = 'high';
  else if (complexity > 10) level = 'medium';
  return { score: complexity, level };
}
```

and the issue title counts

```js
architectureIssues["N High Complexity Files"] = analyzed.filter(
	(f) => f.complexity.level === "critical",
);
```

Three consequences shape every decision below:

1. **The score is token-proportional over RAW text.** Comments and string
   literals count. A split only moves the metric when _every_ sibling lands
   `<= 30`; shuffling branches between files changes nothing.
2. **`.mts` is never scored.** `codeExts` has `.ts` but not `.mts`, so 93 of the
   filed paths cannot move the metric at all. They are recorded as `notScored`,
   never claimed as a reduction.
3. **The filed list is a superset, not the analyzer's flag set.** The same
   defect `god-object-2034` records ("filed 43, only 23 flagged").

## Reproduction

The detector literal has exactly one owner: `test/fixtures/complexity-mirror.mts`
(24 regexes = 9 JS/C + 10 Python + 5 Ruby, re-exporting `ANALYZER_REF` and
`CODE_EXTS` from `long-file-mirror.mts`). Two consumers apply it:

| artifact                                    | role                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `test/complexity-refactor-2033.test.mts`    | per-family and per-sibling `<= 30`, no-new-flag, monotone-envelope invariants |
| `test/codeflow-run-analysis-part5.test.mts` | replays the recorded envelope against the delivered tree                      |

`complexity-refactor-2003.test.mts` now imports the same mirror instead of
inlining its own copy — one literal, one owner.

```bash
node --experimental-strip-types --test test/complexity-refactor-2033.test.mts
```

## The measured envelope

| snapshot                             | commit           | files | scored | critical |
| ------------------------------------ | ---------------- | ----- | ------ | -------- |
| filed baseline (architecture record) | `e075a867`       | 1293  | 732    | 198      |
| merge base (`origin/main`)           | `434bcfde`       | 1561  | 806    | 204      |
| delivered                            | measured in-gate | 1652  | 882    | **192**  |

The tree advanced between `e075a867` and `434bcfde` (main merged more work, adding
and removing flags of its own), which is why the record holds two baselines:
`filedBaseline` proves the architecture's 198, `before` is what this change
actually reduced. Acceptance is the **drop** (−12), and the envelope may only
fall. The delivered tree carries more files and more scored files than its base
(the split adds siblings), so the drop is fewer branches, never fewer files.

## What was split (12 families, 79 parts)

| family                                  | before | parts | seam                                                                         |
| --------------------------------------- | ------ | ----- | ---------------------------------------------------------------------------- |
| `lib/fetch-report.ts`                   | 110    | 8     | use case / HTTP / filesystem / body policy / JSON route / empty slot         |
| `worktree-sandbox/unsafe-write.ts`      | 124    | 8     | entry point / grammars / targets / per-command checkers                      |
| `agent-harness/agent-harness.ts`        | 115    | 8     | state machine / sub-key / meta lookup / guards / bookkeeping                 |
| `supervisor/agent/task.ts`              | 112    | 9     | dispatcher / issue block / conditional blocks / templates / JSON contract    |
| `event/adapter/handlers.ts`             | 104    | 9     | one event family per module + shared phase table                             |
| `supervisor/checks/osv-severity.ts`     | 100    | 7     | CVSS arithmetic / vocabulary / OSV mapping / shapes / census                 |
| `supervisor/agent/output.ts`            | 100    | 8     | facade / parse core / recovery / refusal / typed build / comment extraction  |
| `supervisor/agent/last-json-scanner.ts` | 131    | 7     | scanner / escape state / quote heuristic / sanitizers / fence / line filter  |
| `supervisor/github/git.ts`              | 97     | 6     | commit leaf / push / commit+push / scope gate / exemption / rejection marker |
| `context-info/index.ts`                 | 89     | 9     | composition root / session bootstrap / event wiring / probes                 |
| `supervisor/pipeline/merge.ts`          | 38     | 3     | pre-Done gate vs post-Done orchestration                                     |
| `supervisor/agent/validation.ts`        | 74     | 5     | one validator group per artifact kind                                        |

Every family keeps its documented entry point and re-exports the moved names
**explicitly** — no `export *` — so existing importers are untouched. One
exception is recorded: `event/adapter/index.ts` keeps its star re-exports, because
`adapter-split.test.mts` pins that shape (named re-exports trip TS1205 under
`isolatedModules`). The auditable surface there is `handlers.ts`, which this change
turned into explicit named re-exports.

## What was paid

`N Highly Coupled` rises: siblings reference the same defining files. That is the
accepted cost of a responsibility split (the #2003 record measured 101 → 116 for
the same reason). It is recorded under `tradeoffs.coupling` in
`test/fixtures/complexity-baseline-2033.json` rather than hidden.

Two existing source-text pins had to follow their code:

- `validation.test.mts` reads the three validator helpers from `validation.ts`;
  they now live in `validation-findings.ts` / `validation-score.ts` /
  `validation-optional.ts`, so the pin reads all of them and asserts the barrel
  keeps `export { validateAgentOutput, VALID_SEVERITIES };`.
- `fetch-report-cli.test.mts` pinned `isPathWithinBase` inside
  `lib/fetch-report.ts`; the real-path containment gate moved with the writer it
  guards (`lib/report-store.ts`), so the pin now checks both files.

## What was deliberately not split

Every remaining flag is recorded in the fixture's `deferred` map with a
`requires` pointer, and the oracle asserts that the deferred set **equals** the
measured critical set — a new flag cannot appear unnoticed.

| group                             | n    | requires                                                                       |
| --------------------------------- | ---- | ------------------------------------------------------------------------------ |
| Rust UI (`embedded/docker/ui/**`) | 16   | a lane with the Rust toolchain (`cargo build`/`cargo test`)                    |
| embedded `codeflow`/`lib`/shell   | 6    | the boundary-guard change (embed allow-list, Dockerfile `COPY`, shim copy-set) |
| Go test families (`*_test.go`)    | 34   | its own issue (84 new `package main` files raises coupling)                    |
| remaining JS/TS/Go sources        | ~131 | a later issue with a seam analysis per file                                    |

Cohesive single-concept modules were left whole on purpose: `timed-map.ts`,
`harness-state.ts`, `load-config.ts`, `pipeline/run-lock.ts`. Fragmenting them
lowers a token count and raises reader burden (Ousterhout: split by total
complexity, not by token count).

`server.py` (384) is the sharpest example of the metric being wrong rather than
the code: most of its hits sit inside `_BRIDGE_JS`/`_BRIDGE_SCRIPT`/`_UI_REWRITES`
string literals. Housing those assets outside scored extensions is the only
durable fix, and it is a behaviour-bearing change to a live HTTP server — a
separate issue, not a refactor.
