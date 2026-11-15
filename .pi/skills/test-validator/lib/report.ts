// Domain: report JSON and issue-body policy. Pure — no fs, no network.
//
// The report describes one completed audit (every discovered test decided), and
// the issue body lists only BAD tests: a maintainer must be able to read it and
// decide which tests to remove. Oversized bodies fail closed instead of being
// truncated, because a truncated list would silently drop findings.

import type { InventoryResult, Verdict, VerdictDecision } from "./types.ts";
import { testKey } from "./types.ts";

/** Bumped when the report shape changes. */
const REPORT_SCHEMA_VERSION = 1;

/** GitHub rejects bodies beyond this; we fail closed well before that. */
export const MAX_ISSUE_BODY_BYTES = 65_536;

export interface ReportTestEntry {
	readonly file: string;
	readonly name: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly decision: VerdictDecision;
	readonly confidence: number;
	readonly criteria: readonly string[];
	readonly reason: string;
}

interface ReportExcludedEntry {
	readonly file: string;
	readonly name: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly reason: string;
}

interface ReportCounts {
	readonly discovered: number;
	readonly good: number;
	readonly bad: number;
	readonly pending: number;
	readonly excluded: number;
}

export interface RunReport {
	readonly schemaVersion: number;
	readonly runFingerprint: string;
	readonly headSha: string | null;
	readonly generatedAt: string;
	readonly counts: ReportCounts;
	readonly tests: readonly ReportTestEntry[];
	readonly excluded: readonly ReportExcludedEntry[];
	readonly issue: { readonly url: string } | null;
}

interface BuildReportInput {
	readonly inventory: InventoryResult;
	readonly verdicts: ReadonlyMap<string, Verdict>;
	readonly runFingerprint: string;
	readonly headSha: string | null;
	readonly generatedAt: string;
	readonly issue: { readonly url: string } | null;
}

/** A body that cannot be filed without dropping findings. */
export class IssueBodyTooLargeError extends Error {
	readonly code = "ISSUE_BODY_TOO_LARGE";
	readonly bytes: number;
	constructor(bytes: number) {
		super(
			`issue body is ${bytes} bytes, above the ${MAX_ISSUE_BODY_BYTES}-byte limit; refusing to truncate the BAD list`,
		);
		this.name = "IssueBodyTooLargeError";
		this.bytes = bytes;
	}
}

const UNDECIDED_VERDICT: Verdict = {
	decision: "PENDING",
	confidence: 0,
	criteria: [],
	reason: "",
	evidence: [],
	pendingReason: "not judged",
};

/**
 * Compose the report. Every discovered test appears exactly once in `tests[]`
 * (undecided ones as PENDING), and skipped/todo call sites appear only in
 * `excluded[]`, so `good + bad + pending === discovered`.
 */
export function buildReport(input: BuildReportInput): RunReport {
	const tests: ReportTestEntry[] = input.inventory.tests.map((def) => {
		const verdict = input.verdicts.get(testKey(def)) ?? UNDECIDED_VERDICT;
		return {
			file: def.file,
			name: def.name,
			startLine: def.startLine,
			endLine: def.endLine,
			decision: verdict.decision,
			confidence: verdict.confidence,
			criteria: [...verdict.criteria],
			reason: verdict.reason,
		};
	});

	const excluded: ReportExcludedEntry[] = input.inventory.excluded.map((def) => ({
		file: def.file,
		name: def.name,
		startLine: def.startLine,
		endLine: def.endLine,
		reason: def.reason,
	}));

	const counts: ReportCounts = {
		discovered: tests.length,
		good: tests.filter((entry) => entry.decision === "GOOD").length,
		bad: tests.filter((entry) => entry.decision === "BAD").length,
		pending: tests.filter((entry) => entry.decision === "PENDING").length,
		excluded: excluded.length,
	};

	return {
		schemaVersion: REPORT_SCHEMA_VERSION,
		runFingerprint: input.runFingerprint,
		headSha: input.headSha,
		generatedAt: input.generatedAt,
		counts,
		tests,
		excluded,
		issue: input.issue,
	};
}

/** Hidden marker that makes a filed issue findable on resume. */
export function issueMarker(runFingerprint: string): string {
	return `<!-- test-validator-run:${runFingerprint} -->`;
}

/** Collapse a reason to one table-safe line. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

interface RenderIssueInput {
	readonly runFingerprint: string;
	readonly badTests: readonly ReportTestEntry[];
	/** Decided/excluded totals, for the audit trail at the bottom of the body. */
	readonly counts?: ReportCounts;
}

/**
 * Render the single cleanup issue for the BAD tests.
 *
 * Returns null when there is nothing to file: a run with zero BAD tests must
 * not create an empty review request.
 */
export function renderIssueBody(
	input: RenderIssueInput,
): { readonly title: string; readonly body: string } | null {
	const bad = input.badTests.filter((entry) => entry.decision === "BAD");
	if (bad.length === 0) return null;

	const title = `Test quality review: ${bad.length} BAD tests`;
	const rows = bad.map((entry) => {
		const location = `\`${entry.file}:${entry.startLine}-${entry.endLine}\``;
		const criteria = entry.criteria.join(", ");
		return `| ${location} | ${oneLine(entry.name)} | ${criteria} | ${oneLine(entry.reason)} |`;
	});

	const lines = [
		issueMarker(input.runFingerprint),
		"",
		"## Test quality review",
		"",
		"An automated audit judged every runnable test in this repository against the test-validator criteria.",
		"Each test below was labelled **BAD** with quoted evidence: it provides no meaningful project-specific",
		"regression or contract signal.",
		"",
		"| Test | Name | Criteria | Why it was labelled BAD |",
		"| ---- | ---- | -------- | ----------------------- |",
		...rows,
		"",
	];

	if (input.counts) {
		lines.push(
			`Audit totals: ${input.counts.discovered} judged (${input.counts.good} GOOD, ${input.counts.bad} BAD), ` +
				`${input.counts.excluded} excluded (skip/todo).`,
			"",
		);
	}

	lines.push(
		"**Maintainer action:** review the list and remove the tests you agree with. The audit never deletes tests,",
		"never changes test code, and never re-runs on its own. Re-run the skill after removals to refresh the report.",
		"",
	);

	const body = lines.join("\n");
	const bytes = new TextEncoder().encode(body).length;
	if (bytes > MAX_ISSUE_BODY_BYTES) throw new IssueBodyTooLargeError(bytes);

	return { title, body };
}

/** Stable JSON encoding of the report (tab-indented, trailing newline). */
export function serializeReport(report: RunReport): string {
	return `${JSON.stringify(report, null, "\t")}\n`;
}
