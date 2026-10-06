---
name: codeflow-analysis
description: "Fetch the CodeFlow structural analysis report, turn it into file-isolated git issues, and file them only after explicit user confirmation. Use when asked to analyze CodeFlow output or propose issues from a CodeFlow report."
metadata:
  steps: fetch-report-parse-group-confirm-file
  scope: issues-only-no-commits
  dependencies: codeflow_analysis_report, create-internal-issue, ask_user
---

# CodeFlow Analysis

Turn a CodeFlow analysis into a set of git issues, each touching a disjoint file
set where possible, filed on this repo **only after the user confirms**.

## Trigger

Load this skill when the user asks to:

- "analyze the CodeFlow report" / "pull the CodeFlow analysis"
- "propose issues from CodeFlow" / "file issues from the analysis"
- "what does CodeFlow say about this repo"

## Hard Rules

- **Issues only.** Do not create branches, commits, or PRs. `main` is locked.
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
  bridge POSTs the markdown export to the shim).

## Workflow

### Step 1 — Fetch the report

Call the tool:

```
codeflow_analysis_report
```

It writes the report to `ignore/codeflow-report.md` and returns
`{ path, bytes, analyzedAt }`. If it reports **"No CodeFlow report yet — run
analysis in CodeFlow"**, stop and ask the user to run an analysis in the
CodeFlow UI, then retry with `refresh: true`.

Read `ignore/codeflow-report.md` in full before proceeding.

### Step 2 — Extract issue candidates

The pure parser in `.pi/extensions/codeflow-analysis/report.ts` is the
machine-verifiable spec for this step (`parseReport`, `groupIssues`); mirror its
rules when reading the markdown. It recognizes these sections:

| Section | Kind | File source |
|---------|------|-------------|
| `## Architecture Issues` | architecture | `**Affected:**` paths |
| `## Security Issues` | security | `- **File:**` |
| `## Unused Functions (N)` | dead-code | `- **File:**` |
| `## Duplicates` | duplicate | `**Files:**` |
| `## Layer Violations` | layer-violation | `**Affected files:**` |
| `## Suggestions` | suggestion | `**Affected:**` |

Only keep tokens that name a file path (contain `/` or an extension); drop bare
function names. Unknown, absent, or truncated sections yield no candidates and
must never abort the run.

### Step 3 — Group by file conflict (best-effort isolation)

Build a file-conflict graph: issues that share **any** file are merged
(transitively) into one group. `groupIssues` returns, per group, `isolated`
(a single issue) and `overlaps` (paths claimed by two or more issues).

- **Isolated group →** one issue.
- **Overlapping group →** file one issue covering the whole group, or
  re-sequence the group into separate issues on a dependency order. Either way
  the issue body must state the shared files and that isolation is best-effort.

State best-effort isolation explicitly in every issue body that could not be
fully split: list the files, and say which are shared.

### Step 4 — Draft the issues

For each group, draft an issue using the `create-internal-issue` skill (load it
for the repo's issue template, duplicate check, and project-board wiring). Use
the group's affected files as the scope and include:

- the CodeFlow signal (kind, section, title, description),
- the file list (marking shared files when the group is not isolated),
- the best-effort isolation note.

Do the duplicate check (`gh issue list`) for every draft. Drop drafts that match
an existing open issue; keep the rest as the proposed set.

### Step 5 — Confirmation gate (REQUIRED)

Present the proposed set and ask with `ask_user`, offering exactly three
choices: **all**, **some**, **cancel**.

- **cancel** → stop; create nothing.
- **some** → ask which ones, then create only those.
- **all** → create the full set.

Never proceed to Step 6 without the user's answer.

### Step 6 — File the confirmed issues

Only now file the confirmed drafts via `create-internal-issue` (template,
duplicate check already done, add to the project board). Issues only — no
commits, no branches, no PRs. Report the created issue URLs back to the user.

## Verification

- `ignore/codeflow-report.md` exists and is non-empty before parsing.
- Every proposed issue names at least one file.
- No `gh issue create` ran before the `ask_user` answer.
- Any issue that shares a file with another states that overlap.
