---
layout: default
title: CodeFlow Analysis Report
parent: Extensions
nav_order: 21
---

# CodeFlow Analysis Report

[Extension source](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/codeflow-analysis/index.ts).

The `codeflow_analysis_report` tool retrieves the latest analysis produced by
the local CodeFlow UI and stores its report in the workspace. The analysis
must first be run in the browser; this extension fetches the results and does
not start an analysis itself.

## Tool

| Tool | Behavior |
|---|---|
| `codeflow_analysis_report` | Saves the Markdown report to `ignore/codeflow-report.md` and, when available, the structured JSON report to `ignore/codeflow-report.json`. |

The tool returns the saved paths, Markdown byte count, and analysis timestamp.
The optional `refresh` parameter bypasses the session cache and fetches the
latest report again.

A `404` response means no analysis has been submitted by the browser. Run an
analysis in the CodeFlow UI, wait for it to finish, and call the tool again.
The Markdown export does not include duplicate-code findings, layer
violations, or suggestions; the JSON export contains those categories and is
the preferred source for downstream analysis.

## Output and safety

Both artifacts are written under the workspace's `ignore/` directory. The
extension creates each file through an exclusive temporary file and atomic
rename, and rejects a report directory that resolves outside the workspace
through a symlink. The Markdown report is required; an unavailable JSON report
is reported as a warning and does not discard the Markdown result.

See [Daily Usage](../daily-usage.md#codeflow-code-structure-visualization) for
CodeFlow availability and limitations, and the
[CodeFlow analysis skill](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/skills/audit-codeflow-analysis/SKILL.md) for the
follow-up workflow.
