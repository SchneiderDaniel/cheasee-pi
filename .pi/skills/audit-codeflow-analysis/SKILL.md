---
name: audit-codeflow-analysis
description: "Fetch the CodeFlow structural analysis report, turn its findings into file-isolated git issues, and file them only after explicit user confirmation. Use when asked to analyze CodeFlow output or propose issues from a CodeFlow report."
disable-model-invocation: true
metadata:
  steps: fetch-report-parse-group-confirm-file
  scope: issues-only-no-commits
  dependencies: scripts/fetch-report.mts, git-issue-create-internal, ask_user
---

# CodeFlow Analysis

Turn a CodeFlow analysis into a set of git issues, each touching a mostly
disjoint file set, filed on this repo **only after the user confirms**.

## Trigger

Load this skill when the user asks to:

- "analyze the CodeFlow report" / "pull the CodeFlow analysis"
- "propose issues from CodeFlow" / "file issues from the analysis"
- "what does CodeFlow say about this repo"

## Hard Rules

- **Issues only.** Do not create branches, commits, or PRs. `main` is locked.
- **Reconcile every section before grouping.** A section present in the report
  must yield candidates. A section that emitted `###` items but produced zero
  candidates is being dropped whole by the parser, not empty — stop and fix
  extraction before grouping anything. Never present a partial candidate set
  as a complete audit.
- **Re-check freshness before filing.** The shim replaces the report when a new
  browser run finishes. If `analyzedAt` moved since Step 1, the candidate set no
  longer describes the current analysis: stop and restart from Step 1.
- **Only `bug`-class findings are filed as bugs.** `classifyFinding`
  (`lib/report.ts`) is the single policy source and assigns every fact its issue
  type and disposition before any issue is drafted. `chore` facts are filed as
  refactor issues and `informational` facts are offered as optional filings — both
  after the Step 5 gate, never the bug template.
- **Confirm before filing.** No `gh issue create` (directly or via
  `git-issue-create-internal`) until the user has explicitly confirmed via
  `ask_user`. Drafting is free; creating is not.
- **One subject per issue** with the best-effort file isolation described below,
  and any remaining overlap disclosed in the issue body.

## Preconditions

- The skill-owned fetch script `.pi/skills/audit-codeflow-analysis/scripts/fetch-report.mts`
  is present, and Node runs with `--experimental-strip-types`.
- `ask_user` tool available (the `ask-user` extension).
- The repo-root `.pi/settings.json` (not this skill's directory) has `supervisor.repo` set to `owner/repo`.
- The `codeflow` sidecar carries the headless analyzer (`run-analysis.mjs` + Node),
  so an empty report slot is filled on demand. The browser bridge remains an
  alternative producer.

## Workflow

### Step 1 — Fetch the report

Run the skill-owned fetch script:

```bash
node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/fetch-report.mts
```

If no report is stored yet, the script drives the sidecar's headless run route
(`POST /api/analysis/run`) and polls `/api/analysis/run-status` to completion, so
no browser run is required. The run reuses the pinned CodeFlow analyzer against
the committed `HEAD` snapshot and is bounded by the shim's `run_timeout_s`. No
UI step is needed; the browser bridge is only an alternative producer, and when
the route is absent (old shim) the script keeps its actionable 404.

It writes the report to `ignore/codeflow-report.md` (markdown) and, when the
browser or headless run posted it, `ignore/codeflow-report.json` (structured),
then prints a
single JSON object to stdout:

```json
{ "path": "…", "jsonPath": "…", "bytes": 0, "analyzedAt": 0, "warnings": [], "partial": false, "unavailableCategories": [] }
```

`path` is the markdown artifact, `jsonPath` is the structured artifact (or
`null` when unavailable), `bytes` is the markdown byte count, `analyzedAt` is
the analysis timestamp in epoch ms (or `null`), and `warnings` lists non-fatal
problems (e.g. the JSON route failed). `partial` is `true` whenever no structured
artifact was stored and `unavailableCategories` then names what the run cannot
see. Progress and errors go to stderr.
Exit codes:

| Exit | Meaning |
|------|---------|
| `0` | report fetched and written |
| `2` | no report and no headless run route (old shim) or bad usage — ask the user to run an analysis in the CodeFlow UI |
| `1` | transport, headless-run or write failure |

If it exits **`2`** with **"No CodeFlow report yet — run analysis in CodeFlow"**,
the sidecar has no on-demand run route, so stop and ask the user to run an
analysis in the CodeFlow UI, then retry with `--refresh`. An exit **`1`** naming a
run failure (`timeout`, `analyzer-error`, or analyzer-unavailable) means the
headless analyzer could not produce a report — report that reason instead.

Read `ignore/codeflow-report.md` in full before proceeding, and
`ignore/codeflow-report.json` when `jsonPath` is non-null. When a pre-#1976 shim
serves the JSON export on the markdown route (`recoveredFromMarkdownRoute` true),
the markdown file is a short placeholder — read it, then work from the JSON
export it points at.

Record the returned `analyzedAt` and the `## Summary` table. Every later step
works from that snapshot: the freshness check in Step 6 compares against it, and
filed issue bodies name it so a finding can be traced to the analysis it came
from.

### Step 2 — Extract issue candidates

The pure parser in `.pi/skills/audit-codeflow-analysis/lib/report.ts` is the
machine-verifiable spec for this step (`parseReport` for markdown,
`parseReportJson` for the structured export, `parseBestReport` to pick the
richer source, and `groupIssues`); mirror its rules when reading the artifacts.

Prefer the structured JSON export: it is authoritative and carries categories the
markdown exporter omits. Use markdown only as a fallback.

Structured JSON sources (authoritative):

| Field | Kind | File source |
|-------|------|-------------|
| `architectureIssues[]` | architecture | `affectedFiles[]`, `affectedItems[].file`/`.toFile`, `affectedItems[].files[].file` |
| `duplicates[]` | duplicate | `files[].file` |
| `layerViolations[]` | layer-violation | `from`, `to` |
| `suggestions[]` | suggestion | (none — derived from other signals) |
| `unusedFunctions[]` | dead-code | `file` |
| `securityIssues[]` | security | `path` |

Markdown fallback sections:

| Section | Kind | File source |
|---------|------|-------------|
| `## Architecture Issues` | architecture | `**Affected:**` targets (paths, `A → B` edges, symbols) |
| `## Security Issues` | security | `- **File:**` |
| `## Unused Functions (N)` | dead-code | `- **File:**` |
| `## Design Patterns` | pattern | `**Files:**` |
| `## Anti-Patterns` | anti-pattern | `**Affected files:**` |

The browser bridge classifies each captured export by **structure**, not by a
substring marker or the route it lands on: a body that parses to a JSON object
with an `architectureIssues` array is the structured export, and only then is the
markdown marker considered. This matters because the JSON export embeds the
literal `# CodeFlow Analysis Report` inside its source snippets. The transport
re-sniffs both route bodies for the same reason, so a misrouted or old-shim body
still lands in the correct artifact (`recoveredFromMarkdownRoute`); recovery is
reported as a warning, never silently. When the markdown route recovered an
export, the `.json` route body replaces it only if it is at least as large: a
smaller body is a stale or truncated slot, so the recovered export is kept and
the discard is warned. A body that classifies as the JSON export
is never written to the markdown path, so `path` never points at JSON content;
because that shim serves no markdown narration, the transport writes a short
markdown placeholder to `path` instead of leaving it dangling.

Markdown is narration, **never the sole source of findings**. The markdown
exporter does **not** emit duplicates, layer violations, or suggestions — those
come from the JSON export only. `jsonPath` is null when no *usable* structured
export was stored — absent, or a body that classifies as JSON but yields no facts
(an empty stub). Then the run is **partial**: it
names the categories it cannot see (`duplicate`, `layer-violation`,
`suggestion`) and states they are partially unauditable from markdown. A JSON-less
run never presents itself as complete.
The fetch warning names the owning component using the shim's
`/api/analysis/bridge-status`: `postedAt` null means the browser never POSTed the
JSON export (a capture-side gap); `postedAt` set with a 404 on GET means the
shim's `/api/analysis/report.json` route is down. Either way the JSON-only
categories (duplicates, layer violations, suggestions) are disclosed unavailable,
never silently omitted, and the run states that those categories are partially
unauditable from markdown. A partial refresh also deletes any
`ignore/codeflow-report.json` an earlier analysis left behind, so the artifact set
on disk always matches the current fetch result and a stale file can never make a
partial run look complete.

A `## Architecture Issues` entry's `**Affected:**` line is parsed into **targets**,
not just paths. The markdown exporter emits only `x.name || x.file`, so an item may
name a path (`index.test.ts (46 fns)` — the trailing count is stripped), a layer
edge (`utils → ui`) or a bare symbol (`execFn (3 files)`). All three keep the item
as a candidate; only the `file` kind enters the file-conflict graph. The parser
(`parseReport`) keeps a fact whenever it has at least one target.

Before grouping, run the two checks that keep the candidate set
honest. Both are pure functions in the same module:

1. **Dedupe.** `dedupeIssues(facts)` drops facts whose `(kind, title, targets)`
   already appeared. `files` is the file-only projection of `targets`, so two
   file-less facts that differ only by layer edge or symbol stay distinct. The
   exporter repeats findings (two `on_open()` entries in one file, one security
   issue per matching line), so report the dropped count; never remove findings
   silently.
2. **Reconcile.** `reportSectionCoverage(markdown)` counts the `###` items each
   `## ` section declares against the candidates extracted for that kind. Any
   section with `items > 0 && candidates === 0` is unreadable: stop, fix the
   extraction, and only then continue. Include the coverage table in the run
   report, and read a zero there as "the parser is dropping this", never as "no
   findings in this section". `unparsedItems` counts items with no recoverable
   target, not path-less ones: a `**Affected:**` layer edge (`utils → ui`) or a
   bare symbol (`execFn (3 files)`) is a target and keeps the item as a candidate.
   A section that parsed *some* entries (`unparsedItems > 0` with
   `candidates > 0`) is not unreadable — the coverage table reports the per-entry
   `unparsedItems` and the run lists those titles.

The check is cheap and catches a whole class of silent loss: CodeFlow's derived
architecture metrics arrive as `index.test.ts (46 fns)`, and a section whose every
entry is unparseable disappears without a single error.

Unknown, absent, or truncated sections yield no candidates and must never abort
the run. A section that parsed some entries but still reports `unparsedItems > 0`
is not unreadable: list the unparsed `###` titles (`reportUnparsedItems`) and
disclose that the markdown format could not turn them into candidates.

### Step 3 — Group by file conflict (best-effort isolation)

Build a file-conflict graph: issues that share **any** file are merged
(transitively) into one group. `groupIssues` returns, per group, `isolated`
(a single issue) and `overlaps` (paths claimed by two or more issues).

- **Isolated group →** one issue.
- **Overlapping group →** file one issue covering the whole group, or
  re-sequence the group into separate issues on a dependency order. Either way
  the issue body must state the shared files and that isolation is best-effort.

State best-effort isolation explicitly in every issue body that could not be
fully split: list the files, and say which are shared (disclose the overlap).

### Step 4 — Draft the issues

For each group, draft an issue using the `git-issue-create-internal` skill (load it
for the repo's issue template, duplicate check, and project-board wiring). Use
the group's affected files as the scope and include:

- the CodeFlow signal (kind, section/field, title, description),
- the file list (marking shared files when the group is not isolated),
- the best-effort isolation note,
- the `analyzedAt` of the report the finding came from.

**Kind → issue type.** Scope is decided once, before any issue is drafted, by
`classifyFinding` in `lib/report.ts` — that function is the single policy source.
Consult its result per fact and act on both the returned `issueType` and its
`disposition` (`file-bug` / `file-refactor` / `offer-optional` / `drop`); never
re-derive a kind → issue-type mapping here:

- `bug` (`file-bug`) — a bug-class candidate; draft it with the bug template.
- `chore` (`file-refactor`) — refactor/cleanup scope: draft a refactor issue via
  `git-issue-create-internal` (freeform "Other" path). It is part of the proposed set
  by default, so the run offers work that improves the CodeFlow score; the Step 5
  gate keeps it opt-out, never silently rerouted.
- `informational` (`offer-optional`) — an **opt-in** filing (a descriptive
  observation, not a defect): present it in the Step 5 gate with its disposition
  stated so the user can act on it. Never filed as a bug, never left structurally
  unactionable.
- `out-of-scope` (`drop`) — drop it and state why.

Do the duplicate check (`gh issue list`) for every draft. Drop drafts that match
an existing open issue; keep the rest as the proposed set.

### Step 5 — Confirmation gate (REQUIRED)

Present the proposed set, then ask with `ask_user`, offering exactly three
choices: **all**, **some**, **cancel**.

- **cancel** → stop; create nothing.
- **some** → ask which ones, then create only those.
- **all** → create the full set.

Never proceed to Step 6 without the user's answer. The `chore` (refactor) drafts
are proposed by default and the `informational` (optional) drafts are offered for
opt-in; the gate is where they are accepted or excluded, never a silent drop.

### Step 6 — File the confirmed issues

Only now file the confirmed drafts via `git-issue-create-internal` (template,
duplicate check already done, add to the project board). Issues only — no
commits, no branches, no PRs. Report the created issue URLs back to the user.

Immediately before the first creation, re-fetch with `--refresh` and compare
`analyzedAt` with Step 1. If it changed, the shim has absorbed a newer browser
analysis and every draft was prepared against a superseded report: stop, tell
the user, and restart from Step 1.

### Canonical count vs the UI summary

The skill's canonical unit is the post-`dedupeIssues` `(kind, title, targets)`
tuple (`files` being the file-only projection of `targets`). The CodeFlow
UI summary is a different unit: it dedupes by rule, so it can
report a smaller number (e.g. 9 security issues) than the exported report's
per-entry count (e.g. 37 `###` entries across 7 distinct titles). Disclose the UI
summary separately rather than comparing it directly with the canonical count, and
never reconcile the difference by editing the vendored UI bundle.

## Dry run (creates nothing)

`scripts/dry-run.mts` exercises the extract → resolve → draft path without
touching GitHub: it takes the first N findings, maps each cited file onto the
repo (the markdown exporter emits bare basenames in its pattern sections), and
prints the issue it would file. It spawns no subagent.

```bash
node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts --limit 5
node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts --list        # extraction only, no issue drafts
node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts --emit-findings [DIR]  # write every candidate, no deletion
node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts --self-check   # pure-function checks
```

`--emit-findings [DIR]` writes one `NN-<slug>.md` per post-dedupe candidate
(default `ignore/codeflow-findings/`), spawns no subagent, is not truncated by
`--limit`, and leaves the directory in place. It prints the written count plus a
`dispositions:` line naming each nonzero disposition (`file-bug`,
`file-refactor`, `offer-optional`) with its count. It fails closed (exit `2`,
writes nothing) when the destination already holds `.md` findings, so a rerun can
never mix stale candidates into the set: point at a fresh directory or remove the
stale files first.

It never calls `gh`. Exit `0` for a completed run, `2` for bad usage or a missing
report.

## Verification

- `ignore/codeflow-report.md` exists and is non-empty before parsing.
- When `jsonPath` is null, the run discloses that the JSON-only categories
  (duplicates, layer violations, suggestions) were unavailable, states those
  categories are partially unauditable, and names the owning component (browser
  capture vs shim route) using bridge-status. A JSON body that parses to no facts
  (an empty stub served by the shim's slot) counts as absent, never as complete.
- Every `## ` section that emitted `###` items produced at least one candidate, or
  the run stopped and named the unreadable section. A section with
  `unparsedItems > 0` lists its unparsed `###` titles. A partial candidate set is
  never presented as a complete audit.
- The metric policy is applied once: size/coupling/complexity metrics are routed
  as chore/refactor, never as bugs.
- The `analyzedAt` re-fetch before filing matches the Step 1 value.
- Duplicates dropped by `dedupeIssues` are reported as a count.
- No filed issue used the bug template unless it came from a `bug`-class
  candidate; `chore` facts were filed as refactor issues and `informational` facts
  offered as optional filings, all after the Step 5 gate — none was silently
  routed away or dropped.
- Every proposed issue cites at least one `target`: a file path, a layer edge
  (`utils → ui`), or a symbol (`execFn`), matching the candidate's identity. A
  file-less suggestion must reference the signal that produced it.
- No `gh issue create` ran before the `ask_user` answer.
- Any issue that shares a file with another states that overlap.
