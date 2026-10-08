---
name: audit-codeflow-analysis
description: "Fetch the CodeFlow structural analysis report, verify every finding against the source with read-only subagents, turn the survivors into file-isolated git issues, and file them only after explicit user confirmation. Use when asked to analyze CodeFlow output or propose issues from a CodeFlow report."
disable-model-invocation: true
metadata:
  steps: fetch-report-parse-validate-group-confirm-file
  scope: issues-only-no-commits
  dependencies: codeflow_analysis_report, create-internal-issue, ask_user, validate-finding.sh
---

# CodeFlow Analysis

Turn a CodeFlow analysis into a set of verified git issues, each touching a
mostly disjoint file set, filed on this repo **only after the user confirms**.

CodeFlow reports false positives. Every candidate finding is checked against the
real source by a read-only subagent before it can reach an issue.

## Trigger

Load this skill when the user asks to:

- "analyze the CodeFlow report" / "pull the CodeFlow analysis"
- "propose issues from CodeFlow" / "file issues from the analysis"
- "what does CodeFlow say about this repo"

## Hard Rules

- **Issues only.** Do not create branches, commits, or PRs. `main` is locked.
- **Verify before filing.** Every candidate goes through Step 3. A finding whose
  validation exits `1` is dropped, never filed or re-framed. One whose validation
  exits `2`/`3` is unverified: not filed, and disclosed as unverified.
- **Reconcile every section before validating.** A section present in the report
  must yield candidates. A section that emitted `###` items but produced zero
  candidates is being dropped whole by the parser, not empty — stop and fix
  extraction before validating anything. Never present a partial candidate set
  as a complete audit.
- **Re-check freshness before filing.** The shim replaces the report when a new
  browser run finishes. If `analyzedAt` moved since Step 1, the validated set no
  longer describes the current analysis: stop and restart from Step 1.
- **Informational findings are not issues.** A `pattern` fact (a design pattern
  exists) is never filed. An `anti-pattern` fact that survives validation is
  chore/refactor scope, never bug-template scope.
- **Confirm before filing.** No `gh issue create` (directly or via
  `create-internal-issue`) until the user has explicitly confirmed via
  `ask_user`. Drafting is free; creating is not.
- **One subject per issue** with the best-effort file isolation described below,
  and any remaining overlap disclosed in the issue body.

## Preconditions

- `codeflow_analysis_report` tool available (the `codeflow-analysis` extension).
- `ask_user` tool available (the `ask-user` extension).
- `.pi/settings.json` has `supervisor.repo` set to `owner/repo`.
- The CodeFlow UI has been run at least once in this session (the browser
  bridge POSTs the report exports to the shim).

## Workflow

### Step 1 — Fetch the report

Call the tool:

```
codeflow_analysis_report
```

It writes the report to `ignore/codeflow-report.md` (markdown) and, when the
browser posted it, `ignore/codeflow-report.json` (structured), returning
`{ path, jsonPath, bytes, analyzedAt }`. If it reports **"No CodeFlow report yet
— run analysis in CodeFlow"**, stop and ask the user to run an analysis in the
CodeFlow UI, then retry with `refresh: true`.

Read `ignore/codeflow-report.md` in full before proceeding, and
`ignore/codeflow-report.json` when `jsonPath` is non-null.

Record the returned `analyzedAt` and the `## Summary` table. Every later step
works from that snapshot: the freshness check in Step 7 compares against it, and
filed issue bodies name it so a finding can be traced to the analysis it came
from.

### Step 2 — Extract issue candidates

The pure parser in `.pi/extensions/codeflow-analysis/report.ts` is the
machine-verifiable spec for this step (`parseReport` for markdown,
`parseReportJson` for the structured export, `parseBestReport` to pick the
richer source, and `groupIssues`); mirror its rules when reading the artifacts.

Prefer the structured JSON export: it is authoritative and carries categories the
markdown exporter omits. Use markdown only as a fallback.

Structured JSON sources (authoritative):

| Field | Kind | File source |
|-------|------|-------------|
| `architectureIssues[]` | architecture | `affectedFiles[]` |
| `duplicates[]` | duplicate | `files[].file` |
| `layerViolations[]` | layer-violation | `from`, `to` |
| `suggestions[]` | suggestion | (none — derived from other signals) |
| `unusedFunctions[]` | dead-code | `file` |
| `securityIssues[]` | security | `path` |

Markdown fallback sections:

| Section | Kind | File source |
|---------|------|-------------|
| `## Architecture Issues` | architecture | `**Affected:**` paths |
| `## Security Issues` | security | `- **File:**` |
| `## Unused Functions (N)` | dead-code | `- **File:**` |
| `## Design Patterns` | pattern | `**Files:**` |
| `## Anti-Patterns` | anti-pattern | `**Affected files:**` |

The markdown exporter does **not** emit duplicates, layer violations, or
suggestions — those come from the JSON export only. When `jsonPath` is null, say
so and proceed with the markdown categories rather than silently omitting them.

Then, before validating anything, run the two checks that keep the candidate set
honest. Both are pure functions in the same module:

1. **Dedupe.** `dedupeIssues(facts)` drops facts whose `(kind, title, files)`
   already appeared. The exporter repeats findings (two `on_open()` entries in
   one file, one security issue per matching line) and validation is per fact, so
   every duplicate is a wasted read-only subagent run. Report the dropped count;
   never remove findings silently.
2. **Reconcile.** `reportSectionCoverage(markdown)` counts the `###` items each
   `## ` section declares against the candidates extracted for that kind. Any
   section with `items > 0 && candidates === 0` is unreadable: stop, fix the
   extraction, and only then continue. Include the coverage table in the run
   report, and read a zero there as "the parser is dropping this", never as "no
   findings in this section".

The check is cheap and catches a whole class of silent loss: CodeFlow's derived
architecture metrics arrive as `index.test.ts (46 fns)`, and a section whose every
entry is unparseable disappears without a single error.

Only keep tokens that name a file path (contain `/` or an extension); drop bare
function names and layer labels. Unknown, absent, or truncated sections yield no
candidates and must never abort the run.

### Step 3 — Validate every candidate (read-only subagent)

A finding is a candidate until the source confirms it. Write each candidate to
`ignore/codeflow-findings/NN-<slug>.md` (kind, section/field, title, description,
claimed files), then validate all of them in one batched `bash` call:

```bash
for f in ignore/codeflow-findings/*.md; do
  .pi/skills/audit-codeflow-analysis/scripts/validate-finding.sh "$f" > "${f%.md}.verdict" &
  while [ "$(jobs -rp | wc -l)" -ge 4 ]; do wait -n; done
done
wait
```

The script spawns `pi -p` with `--tools
read,ripgrep_search,structural_search`, the `references/finding-validator.md`
system prompt, this session's model, and no project skills or context files. Exit
codes:

| Exit | Meaning | Action |
|------|---------|--------|
| `0` | `VERDICT: VALID` | keep it for Step 4 |
| `1` | `VERDICT: INVALID` | drop it; keep the `REASON` line for the confirmation list |
| `2` | usage / repo-root error | fix the call and rerun |
| `3` | subagent failed or printed no verdict | unverified — never file, disclose as unverified |

Take the verdict from code the subagent read itself. Reject any verdict whose
`EVIDENCE` names a path that does not exist. Never re-run a validator hoping for
a different answer. Cap parallel spawns at 4, and delete
`ignore/codeflow-findings/` when the run ends.

### Step 4 — Group by file conflict (best-effort isolation)

Build a file-conflict graph: issues that share **any** file are merged
(transitively) into one group. `groupIssues` returns, per group, `isolated`
(a single issue) and `overlaps` (paths claimed by two or more issues).

- **Isolated group →** one issue.
- **Overlapping group →** file one issue covering the whole group, or
  re-sequence the group into separate issues on a dependency order. Either way
  the issue body must state the shared files and that isolation is best-effort.

State best-effort isolation explicitly in every issue body that could not be
fully split: list the files, and say which are shared (disclose the overlap).

### Step 5 — Draft the issues

For each group, draft an issue using the `create-internal-issue` skill (load it
for the repo's issue template, duplicate check, and project-board wiring). Use
the group's affected files as the scope and include:

- the CodeFlow signal (kind, section/field, title, description),
- the file list (marking shared files when the group is not isolated),
- the best-effort isolation note,
- the `analyzedAt` of the report the finding came from.

**Kind → issue type.** `pattern` is informational — record it in the run summary
and stop there, it is not a defect and has no issue. `anti-pattern` is
chore/refactor work: draft it through the freeform "Other" path. `security`,
`dead-code`, `architecture`, `duplicate`, `layer-violation` and `suggestion` use
the bug template.

Do the duplicate check (`gh issue list`) for every draft. Drop drafts that match
an existing open issue; keep the rest as the proposed set.

### Step 6 — Confirmation gate (REQUIRED)

Present the proposed set — and, separately, the findings dropped in Step 3 with
their `REASON` — then ask with `ask_user`, offering exactly three choices:
**all**, **some**, **cancel**.

- **cancel** → stop; create nothing.
- **some** → ask which ones, then create only those.
- **all** → create the full set.

Never proceed to Step 7 without the user's answer.

### Step 7 — File the confirmed issues

Only now file the confirmed drafts via `create-internal-issue` (template,
duplicate check already done, add to the project board). Issues only — no
commits, no branches, no PRs. Report the created issue URLs back to the user.

Immediately before the first creation, re-fetch with `refresh: true` and compare
`analyzedAt` with Step 1. If it changed, the shim has absorbed a newer browser
analysis and every verdict was reached against a superseded report: stop, tell
the user, and restart from Step 1.

## Dry run (creates nothing)

`scripts/dry-run.mts` exercises the extract → resolve → validate path without
touching GitHub: it takes the first N findings, maps each cited file onto the
repo (the markdown exporter emits bare basenames in its pattern sections),
validates every finding with a read-only subagent, and prints the issue it would
file — or, for a false finding, the validator's reason and evidence.

```bash
node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts --limit 5
node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts --list        # extraction only, no subagents
node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts --self-check   # pure-function checks
```

It never calls `gh`. Exit `0` for a completed run even when every finding is
false, `2` for bad usage or a missing report.

## Verification

- `ignore/codeflow-report.md` exists and is non-empty before parsing.
- When `jsonPath` is null, the run discloses that the JSON-only categories
  (duplicates, layer violations, suggestions) were unavailable.
- Every `## ` section that emitted `###` items produced at least one candidate,
  or the run stopped and named the unreadable section. A partial candidate set is
  never presented as a complete audit.
- The `analyzedAt` re-fetch before filing matches the Step 1 value.
- Duplicates dropped by `dedupeIssues` are reported as a count.
- No `pattern` fact was filed, and no `anti-pattern` fact used the bug template.
- Every proposed issue names at least one file (except file-less suggestions,
  which must reference the signal that produced them).
- Every filed issue's finding exited `0` from `validate-finding.sh`; every
  dropped finding has a recorded `REASON`.
- No `gh issue create` ran before the `ask_user` answer.
- Any issue that shares a file with another states that overlap.
