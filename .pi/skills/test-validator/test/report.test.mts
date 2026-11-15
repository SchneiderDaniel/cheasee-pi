// Phase 6 — report JSON and issue-body policy. Pure functions, so the shape of
// what a maintainer sees is testable without a filesystem.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { discoverTests } from "../lib/inventory.ts";
import {
	IssueBodyTooLargeError,
	MAX_ISSUE_BODY_BYTES,
	buildReport,
	issueMarker,
	renderIssueBody,
	serializeReport,
} from "../lib/report.ts";
import type { ReportTestEntry, RunReport } from "../lib/report.ts";
import type { Verdict } from "../lib/types.ts";

const RUN_FINGERPRINT = "b".repeat(64);
const HEAD_SHA = "cafebabe";

const SOURCE = [
	'import { describe, it } from "node:test";',
	'describe("suite", () => {',
	'\tit("a-good", () => {',
	"\t\tassert.equal(1, 1);",
	"\t});",
	'\tit("b-bad", () => {',
	"\t\tassert.ok(true);",
	"\t});",
	'\tit.skip("c-skipped", () => {});',
	'\tit.todo("d-todo");',
	"});",
].join("\n");

const INVENTORY = discoverTests(SOURCE, "src/a.test.mts");

function keyOf(index: number): string {
	const def = INVENTORY.tests[index];
	return `${def.file}:${def.startLine}-${def.endLine}:${def.name}`;
}

function verdict(decision: "GOOD" | "BAD" | "PENDING", overrides: Partial<Verdict> = {}): Verdict {
	return {
		decision,
		confidence: decision === "PENDING" ? 0 : 0.9,
		criteria: decision === "PENDING" ? [] : ["C1"],
		reason: decision === "PENDING" ? "" : `${decision.toLowerCase()} reason`,
		evidence: [],
		pendingReason: decision === "PENDING" ? "ambiguous" : "",
		...overrides,
	};
}

function decidedMap(): Map<string, Verdict> {
	return new Map([
		[
			keyOf(0),
			verdict("GOOD", { criteria: ["C1", "C2"], reason: "asserts a project-owned contract" }),
		],
		[
			keyOf(1),
			verdict("BAD", { criteria: ["C2", "C4"], reason: "assertion restates | a literal" }),
		],
	]);
}

function build(
	overrides: { verdicts?: Map<string, Verdict>; issue?: { url: string } | null } = {},
): RunReport {
	return buildReport({
		inventory: INVENTORY,
		verdicts: overrides.verdicts ?? decidedMap(),
		runFingerprint: RUN_FINGERPRINT,
		headSha: HEAD_SHA,
		generatedAt: "2026-01-01T00:00:00.000Z",
		issue: overrides.issue ?? null,
	});
}

describe("report: counts and shape", () => {
	it("accounts for every discovered test and lists excluded ones separately", () => {
		const report = build();
		const { counts } = report;

		assert.equal(counts.discovered, 2);
		assert.equal(counts.excluded, 2);
		assert.equal(counts.good + counts.bad + counts.pending, counts.discovered);
		assert.equal(counts.good, 1);
		assert.equal(counts.bad, 1);
		assert.equal(counts.pending, 0);
	});

	it("counts an undecided test as pending", () => {
		const report = build({ verdicts: new Map([[keyOf(0), verdict("GOOD")]]) });

		assert.equal(report.counts.pending, 1);
		assert.equal(
			report.counts.good + report.counts.bad + report.counts.pending,
			report.counts.discovered,
		);
	});

	it("gives every test entry its location and decision", () => {
		for (const entry of build().tests) {
			assert.equal(typeof entry.file, "string");
			assert.equal(typeof entry.name, "string");
			assert.equal(Number.isInteger(entry.startLine), true);
			assert.equal(Number.isInteger(entry.endLine), true);
			assert.ok(["GOOD", "BAD", "PENDING"].includes(entry.decision));
			assert.ok(entry.startLine <= entry.endLine);
		}
	});

	it("carries the run fingerprint and head sha", () => {
		const report = build();

		assert.equal(report.runFingerprint, RUN_FINGERPRINT);
		assert.equal(report.headSha, HEAD_SHA);
		assert.equal(typeof report.schemaVersion, "number");
		assert.equal(typeof report.generatedAt, "string");
	});

	it("keeps skip and todo call sites out of tests[]", () => {
		const report = build();

		assert.deepEqual(
			report.excluded.map((entry) => [entry.name, entry.reason]),
			[
				["suite > c-skipped", "skip"],
				["suite > d-todo", "todo"],
			],
		);
		assert.equal(
			report.tests.some((entry) => entry.name.includes("skipped") || entry.name.includes("todo")),
			false,
		);
	});

	it("round-trips through JSON with no undefined fields", () => {
		const report = build({ issue: { url: "https://example.test/1" } });
		const parsed = JSON.parse(serializeReport(report)) as RunReport;

		assert.deepEqual(parsed, JSON.parse(JSON.stringify(report)));
		assert.equal(serializeReport(report).includes("undefined"), false);
		assert.deepEqual(parsed, report);
	});
});

describe("report: issue body policy", () => {
	function badEntries(): ReportTestEntry[] {
		return build().tests.filter((entry) => entry.decision === "BAD");
	}

	it("titles the issue with the BAD count", () => {
		const rendered = renderIssueBody({ runFingerprint: RUN_FINGERPRINT, badTests: badEntries() });

		assert.ok(rendered);
		assert.equal(rendered.title, "Test quality review: 1 BAD tests");
	});

	it("lists each BAD test on one line with location, name, criteria, and reason", () => {
		const rendered = renderIssueBody({ runFingerprint: RUN_FINGERPRINT, badTests: badEntries() });
		assert.ok(rendered);

		const rows = rendered.body.split("\n").filter((line) => line.includes("b-bad"));
		assert.equal(rows.length, 1);
		const [row] = rows;
		assert.match(row, /src\/a\.test\.mts:6-8/);
		assert.match(row, /b-bad/);
		assert.match(row, /C2, C4/);
		assert.match(row, /assertion restates/);
	});

	it("omits GOOD and pending tests from the body", () => {
		const entries = build({
			verdicts: new Map([
				[keyOf(0), verdict("GOOD")],
				[keyOf(1), verdict("BAD", { reason: "no assertion" })],
			]),
		}).tests;
		const rendered = renderIssueBody({ runFingerprint: RUN_FINGERPRINT, badTests: entries });
		assert.ok(rendered);

		assert.equal(rendered.body.includes("a-good"), false);
	});

	it("carries the hidden marker exactly once, matching the fingerprint", () => {
		const rendered = renderIssueBody({ runFingerprint: RUN_FINGERPRINT, badTests: badEntries() });
		assert.ok(rendered);

		const marker = issueMarker(RUN_FINGERPRINT);
		assert.equal(rendered.body.split(marker).length - 1, 1);
		assert.match(marker, /<!-- test-validator-run:[0-9a-f]{64} -->/);
	});

	it("returns no body when nothing is BAD", () => {
		const rendered = renderIssueBody({ runFingerprint: RUN_FINGERPRINT, badTests: [] });

		assert.equal(rendered, null);
	});

	it("fails closed on an oversized body instead of truncating", () => {
		const huge: ReportTestEntry[] = Array.from({ length: 300 }, (_, index) => ({
			file: `src/generated-${index}.test.mts`,
			name: `very long test name number ${index} ${"x".repeat(80)}`,
			startLine: 1,
			endLine: 2,
			decision: "BAD",
			confidence: 0.9,
			criteria: ["C1", "C2"],
			reason: "y".repeat(200),
		}));

		assert.throws(
			() => renderIssueBody({ runFingerprint: RUN_FINGERPRINT, badTests: huge }),
			(err: unknown) => {
				assert.ok(err instanceof IssueBodyTooLargeError);
				assert.ok(err.bytes > MAX_ISSUE_BODY_BYTES);
				assert.match(err.message, new RegExp(String(MAX_ISSUE_BODY_BYTES)));
				return true;
			},
		);
	});
});
