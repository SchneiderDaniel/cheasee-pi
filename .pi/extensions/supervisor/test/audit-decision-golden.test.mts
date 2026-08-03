/**
 * Golden-master (characterization) tests for the audit decision module.
 *
 * Captures the { nextStatus, note, duplicateCodeResult, deadCodeResult,
 * vulnResult } output of decideAudit over the exhaustive failure-subset
 * matrix and replays it byte-identical on subsequent runs. Any incidental
 * drift (whitespace, rewording, reorder, dedupe) after a refactor fails
 * here — this is the proof that the Implementation vs Audit decision is
 * unchanged by the audit.ts split (issue #1407).
 *
 * Capture mode (one-time, on the PRE-split semantics, commits the fixture):
 *   AUDIT_GOLDEN_CAPTURE=1 node --experimental-strip-types --test .pi/extensions/supervisor/test/audit-decision-golden.test.mts
 *
 * Compare mode (default): deep-equals replay vs the committed fixture.
 * Missing fixture in compare mode = hard fail (fail closed, no silent capture).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/audit-decision-golden.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";

import {
	decideAudit,
	type AuditDecision,
	type AuditGateResults,
} from "../pipeline/audit/aggregate.ts";

const FIXTURE_URL = new URL("./fixtures/audit-decision-golden.json", import.meta.url);
const CAPTURE = process.env.AUDIT_GOLDEN_CAPTURE === "1";

// ═══════════════════════════════════════════════════════════════════════
// Corpus — fixed failure sets whose full decision output is pinned
// byte-identical. Section strings mirror the gate formats produced by
// pre-gates/tsc-gate/lsp-gate in audit.ts today.
// ═══════════════════════════════════════════════════════════════════════

const CI_SECTION = "--- CI Gate ---\n2 check(s) failed: build, lint";
const DEAD_SECTION = "--- Dead Code Gate ---\nDEAD_CODE_FOUND: 1 finding(s) found (4 lines)";
const OSV_SECTION =
	"--- OSV Vulnerability Gate ---\n2 critical vulnerability(ies) in production dependencies";
const TSC_SECTION =
	"--- TypeScript Checkpoint ---\nTSC checkpoint: 3 type error(s) found — fix before proceeding.\n...";
const LSP_SECTION = "--- LSP Pre-Audit ---\nLSP audit failed: 1 blocking diagnostic";

const RESULTS_ALL_PASS: AuditGateResults = {
	duplicateCodeResult: {
		status: "clean",
		clones: [],
		totalDuplicateLines: 0,
		changedFilesScanned: ["src/main.ts"],
	},
	deadCodeResult: {
		status: "clean",
		findings: [],
		totalDeadLines: 0,
		changedFilesScanned: ["src/main.ts"],
	},
	vulnResult: {
		status: "clean",
		findings: [],
		counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
		ccFindingsFlagged: false,
	},
};

interface Scenario {
	id: string;
	failures: string[];
	lastNote: string;
	results: AuditGateResults;
}

const SCENARIOS: Scenario[] = [
	{
		id: "all-pass-with-note",
		failures: [],
		lastNote: "LSP audit passed: no diagnostics",
		results: RESULTS_ALL_PASS,
	},
	{
		id: "all-pass-empty-note",
		failures: [],
		lastNote: "",
		results: {},
	},
	{
		id: "single-ci-failure",
		failures: [CI_SECTION],
		lastNote: "LSP audit passed: no diagnostics",
		results: RESULTS_ALL_PASS,
	},
	{
		id: "single-dead-failure",
		failures: [DEAD_SECTION],
		lastNote: "LSP audit passed: no diagnostics",
		results: RESULTS_ALL_PASS,
	},
	{
		id: "single-osv-blocking",
		failures: [OSV_SECTION],
		lastNote: "LSP audit passed: no diagnostics",
		results: RESULTS_ALL_PASS,
	},
	{
		id: "single-tsc-failure",
		failures: [TSC_SECTION],
		lastNote: "LSP audit passed: no diagnostics",
		results: RESULTS_ALL_PASS,
	},
	{
		id: "single-lsp-failure",
		failures: [LSP_SECTION],
		lastNote: "LSP audit failed: 1 blocking diagnostic",
		results: RESULTS_ALL_PASS,
	},
	{
		// Multi-failure: sections joined with "\n\n" in push order
		// CI → Dead → OSV → TSC → LSP (order shapes the note byte-for-byte).
		id: "multi-failure",
		failures: [CI_SECTION, DEAD_SECTION, OSV_SECTION, TSC_SECTION, LSP_SECTION],
		lastNote: "LSP audit failed: 1 blocking diagnostic",
		results: RESULTS_ALL_PASS,
	},
	{
		// Results threaded verbatim through the failure branch too.
		id: "failure-with-results-passthrough",
		failures: [CI_SECTION],
		lastNote: "",
		results: RESULTS_ALL_PASS,
	},
];

function runScenarios(): AuditDecision[] {
	return SCENARIOS.map((s) => decideAudit(s.failures, s.lastNote, s.results));
}

describe("audit decision golden corpus (issue #1407 split)", () => {
	it("decision output is byte-identical to the committed fixture", () => {
		const results = runScenarios();

		if (CAPTURE) {
			writeFileSync(FIXTURE_URL, JSON.stringify(results, null, 2) + "\n", "utf8");
			console.log(`[golden] captured ${results.length} scenarios → ${FIXTURE_URL}`);
			return;
		}

		let fixtureRaw: string;
		try {
			fixtureRaw = readFileSync(FIXTURE_URL, "utf8");
		} catch {
			assert.fail(
				"Golden fixture missing — run with AUDIT_GOLDEN_CAPTURE=1 on the pre-split semantics to create it (fail closed, no silent capture)",
			);
		}

		assert.deepEqual(results, JSON.parse(fixtureRaw) as AuditDecision[]);
	});
});
