#!/usr/bin/env node
/**
 * Dry run of the codeflow-analysis skill.
 *
 * Extracts findings from the CodeFlow report and PRINTS the issues the skill
 * would file. Nothing is created and no subagent is spawned: this script never
 * calls `gh`.
 *
 * Usage:
 *   node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts
 *   ... --limit 5 --report ignore/codeflow-report.md --json ignore/codeflow-report.json
 *   ... --list | --emit-findings [DIR] | --emit-issues [DIR] | --self-check
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	classifyFinding,
	dedupeIssues,
	hasStructuredFindings,
	parseBestReport,
	reportSectionCoverage,
	type Disposition,
	type IssueFact,
	type IssueType,
	type SectionCoverage,
	type Target,
} from "../lib/report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

import {
	draftIssue,
	describeTargets,
	renderResolved,
	indexBasenames,
	resolveCited,
	dispositionSummary,
	groupFactsBySubject,
	groupFactsByFileGraph,
	readAnalyzedAt,
	writeIssueFiles,
	issueTable,
	writeFindingFiles,
} from "./dry-run-lib.mts";
import type { DraftGroup, FileResolution } from "./dry-run-lib.mts";
import { parseArgs, selfCheck, jsonNote, coverageReport } from "./dry-run-args.mts";
export { slugifyFinding } from "./dry-run-lib.mts";

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.selfCheck) process.exit(selfCheck());

	const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: HERE,
		encoding: "utf-8",
	}).trim();
	const reportPath = resolve(repoRoot, args.report);
	if (!existsSync(reportPath)) {
		process.stderr.write(
			`report not found: ${reportPath}\nRun an analysis in the CodeFlow UI first.\n`,
		);
		process.exit(2);
	}
	const jsonPath = args.json
		? resolve(repoRoot, args.json)
		: join(repoRoot, "ignore/codeflow-report.json");
	const jsonContent = existsSync(jsonPath) ? readFileSync(jsonPath, "utf-8") : null;
	// The single usability predicate: a format-valid but facts-less stub is not a
	// structured export, so the run must fall back to markdown and disclose it.
	const json = hasStructuredFindings(jsonContent) ? jsonContent : null;
	const markdown = readFileSync(reportPath, "utf-8");

	const facts = parseBestReport(markdown, json);
	if (facts.length === 0) {
		process.stderr.write(`no findings parsed from ${reportPath}\n`);
		process.exit(2);
	}

	// Guardrail: a section that emitted `###` items but parsed to zero candidates
	// means the parser is dropping it whole, not that the section is empty. The
	// markdown export is the only source with sections to count.
	const coverage = reportSectionCoverage(markdown);
	const uncovered = coverage.filter((c) => c.items > 0 && c.candidates === 0);
	if (uncovered.length > 0) {
		process.stdout.write(
			`WARNING: ${uncovered.length} section(s) emitted items but yielded no candidates — ` +
				`the parser is dropping them:\n` +
				uncovered.map((c) => `  ${c.heading}: ${c.items} item(s), 0 candidates\n`).join("") +
				`Fix the extraction before trusting this candidate set.\n\n`,
		);
	}

	const unique = dedupeIssues(facts);

	const basenameIndex = indexBasenames(
		execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf-8" })
			.split("\n")
			.filter((l) => l !== ""),
	);
	const resolveFile = (file: string): FileResolution =>
		resolveCited((p) => existsSync(resolve(repoRoot, p)), basenameIndex, file);

	// Every deduped finding is a candidate. Scope is decided once, here, by
	// `classifyFinding` (the single policy source): metrics and informational
	// facts are routed to refactor/optional issues, the rest are bug-class.
	const candidates = unique;
	const issueTypeOf = (fact: IssueFact): IssueType => classifyFinding(fact).issueType;
	const routed = candidates.filter((f) => issueTypeOf(f) !== "bug");
	// Derived facts restate findings that are already candidates, so they are listed
	// (the operator sees the whole signal) but never drafted: filing one produced a
	// file-less issue whose count contradicted the export.
	const derivedCount = candidates.filter(
		(f) => classifyFinding(f).disposition === "link-derived",
	).length;
	const filed = (groups: DraftGroup[]): DraftGroup[] =>
		groups.filter((g) => g.dispositions.some((d) => d !== "link-derived"));

	if (args.emitFindings) {
		// Extraction only: write the candidate set and exit. No subagent is
		// spawned, --limit does not truncate, and the directory is never removed.
		const dir = resolve(repoRoot, args.emitDir ?? "ignore/codeflow-findings");
		const files = writeFindingFiles(dir, candidates);
		process.stdout.write(
			`CodeFlow findings emitted — ${files.length} candidate(s) written to ${dir.replace(`${repoRoot}/`, "")}\n` +
				`${routed.length} finding(s) routed by triage to refactor/optional issues.\n` +
				`dispositions: ${dispositionSummary(candidates)}\n` +
				`\n${coverageReport(markdown, coverage)}` +
				(!json ? `\n${jsonNote()}` : "") +
				`\nNo issues created.\n`,
		);
		process.exit(0);
	}

	if (args.emitIssues) {
		// Grouped, template-appropriate issue drafts. Still creates nothing and
		// calls no `gh`; the confirmation gate decides what is filed.
		const groups =
			args.by === "group" ? groupFactsByFileGraph(candidates) : groupFactsBySubject(candidates);
		const draftable = filed(groups);
		const analyzedAt = args.analyzedAt ?? readAnalyzedAt(json, markdown);
		const dir = resolve(repoRoot, args.emitIssuesDir ?? "ignore/codeflow-issue-drafts");
		const files = writeIssueFiles(dir, draftable, { analyzedAt, allGroups: draftable });
		process.stdout.write(
			`CodeFlow issue drafts — ${files.length} proposed issue(s) written to ${dir.replace(`${repoRoot}/`, "")}\n` +
				`grouping: ${args.by}\n` +
				`analyzedAt: ${analyzedAt ?? "(unknown — pass --analyzed-at)"}\n` +
				`dispositions: ${dispositionSummary(candidates)}\n` +
				(derivedCount > 0 ? `${derivedCount} derived fact(s) listed, not filed.\n` : "") +
				`\nproposed set:\n${issueTable(draftable)}\n` +
				`\n${coverageReport(markdown, coverage)}` +
				(!json ? `\n${jsonNote()}` : "") +
				`\nNo issues created.\n`,
		);
		process.exit(0);
	}

	if (args.listOnly) {
		const cited = candidates.flatMap((f) => f.files).map(resolveFile);
		for (const [i, fact] of candidates.entries()) {
			const files =
				fact.files.length > 0
					? fact.files.map((f) => renderResolved(f, resolveFile(f))).join(", ")
					: "(none)";
			process.stdout.write(
				`[${i + 1}] ${fact.kind} — ${fact.title} [${issueTypeOf(fact)}]\n` +
					`      targets: ${describeTargets(fact)}\n      files: ${files}\n`,
			);
		}
		const unresolved = cited.filter((r) => r.how === "unresolved");
		process.stdout.write(`\n${coverageReport(markdown, coverage)}`);
		if (!json) process.stdout.write(`\n${jsonNote()}`);
		process.stdout.write(
			`\n${candidates.length} finding(s), ${routed.length} routed by triage to refactor/optional issues, ` +
				`${cited.length} cited file(s), ${cited.length - unresolved.length} found, ` +
				`${unresolved.length} unresolved.\n` +
				`dispositions: ${dispositionSummary(candidates)}\n` +
				`No issues created.\n`,
		);
		process.exit(0);
	}

	const selected = candidates.slice(0, args.limit);

	const sourceLabel = json ? "json" : "markdown";
	process.stdout.write(
		`CodeFlow dry run — ${reportPath.replace(`${repoRoot}/`, "")} (${sourceLabel}, ` +
			`${facts.length} finding(s), ${unique.length} unique, ${facts.length - unique.length} duplicate(s) dropped)\n` +
			`${routed.length} finding(s) routed by triage:\n` +
			routed.map((f) => `  [${issueTypeOf(f)}] ${f.title}\n`).join("") +
			`dispositions: ${dispositionSummary(candidates)}\n` +
			`\n${coverageReport(markdown, coverage)}\n` +
			(!json ? jsonNote() : "") +
			`Would file ${candidates.length} issue(s); printing the first ${selected.length}. No issues are created.\n\n`,
	);

	selected.forEach((fact, i) => {
		const files =
			fact.files.length > 0
				? fact.files.map((f) => renderResolved(f, resolveFile(f))).join(", ")
				: "(none)";
		const draft = draftIssue(fact, sourceLabel, issueTypeOf(fact));
		process.stdout.write(
			`[${i + 1}/${selected.length}] ${fact.kind} — ${fact.title}\n      files: ${files}\n`,
		);
		process.stdout.write(`      Title: ${draft.title}\n`);
		for (const line of draft.body.split("\n")) process.stdout.write(`      │ ${line}\n`);
		process.stdout.write("\n");
	});

	const cited = candidates.flatMap((f) => f.files).map(resolveFile);
	const byBasename = cited.filter((r) => r.how === "basename").length;
	const unresolved = cited.filter((r) => r.how === "unresolved");
	process.stdout.write(
		`Summary: ${candidates.length} candidate(s) — would file ${candidates.length} issue(s), ` +
			`${routed.length} routed by triage.\n` +
			`Codebase link: ${cited.length - unresolved.length}/${cited.length} cited file(s) found` +
			`${byBasename > 0 ? ` (${byBasename} by basename)` : ""}` +
			`${unresolved.length > 0 ? `; unresolved: ${unresolved.map((r) => r.path).join(", ")}` : ""}.\n` +
			`No issues created (dry run).\n`,
	);
	process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		process.stderr.write(`dry run failed: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	});
}
