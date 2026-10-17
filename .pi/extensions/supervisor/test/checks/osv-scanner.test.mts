import { describe, it } from "node:test";

import assert from "node:assert/strict";

import {
	type OsvFinding,
	type OsvScanResult,
	parseOsvJson,
	bucketBySeverity,
	cvss3BaseScore,
	severityFromBaseScore,
} from "../../checks/osv-scanner.ts";

import type { ExecFn } from "../../checks/shared.ts";

import {
	CLEAN_JSON,
	VULNS_JSON,
	VULN_MULTI_ALIAS_JSON,
	CC_COMMIT_MATCH_JSON,
	EMPTY_PACKAGES_JSON,
	NO_VULNS_PACKAGES_JSON,
	VECTOR_ONLY_CRITICAL_JSON,
	RUSTSEC_VECTOR_JSON,
	MODERATE_JSON,
	AFFECTED_ONLY_JSON,
	AFFECTED_ECO_JSON,
	NUMERIC_SCORE_JSON,
	CVSS_TYPE_VOCAB_FABRICATION_JSON,
	AFFECTED_ECOSYSTEM_MISMATCH_JSON,
	AFFECTED_FOREIGN_ECOSYSTEM_JSON,
	MALFORMED_VECTOR_JSON,
} from "./osv-scanner-fixtures.mts";

import { UNPARSEABLE_JSON, CVSS_NUMERIC_BOUNDARY_JSON } from "./osv-scanner-fixtures-b.mts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts?: Record<string, unknown>;
}

function createMockExec(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExecFn {
	const callLog = calls || [];
	let idx = 0;
	const fn: ExecFn = async (cmd, args, opts) => {
		callLog.push({ cmd, args: args || [], opts });
		const r = results[idx] || { code: 0, stdout: "", stderr: "" };
		idx++;
		return Promise.resolve(r);
	};
	(fn as unknown as { calls: ExecCall[] }).calls = callLog;
	return fn;
}

function createRejectingExec(error: unknown): ExecFn {
	return async (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
		throw error;
	};
}

describe("parseOsvJson()", () => {
	it("valid JSON with vulnerabilities returns vulns_found with correct findings", () => {
		const result = parseOsvJson(VULNS_JSON);
		assert.equal(result.status, "vulns_found");
		assert.equal(result.findings.length, 4);

		// Check first finding: lodash HIGH
		const lodashHigh = result.findings.find((f) => f.id === "GHSA-xxxx-xxxx-xxxx");
		assert.ok(lodashHigh, "lodash high severity finding should exist");
		assert.equal(lodashHigh!.severity, "HIGH");
		assert.equal(lodashHigh!.packageName, "lodash");
		assert.equal(lodashHigh!.packageVersion, "4.17.20");
		assert.equal(lodashHigh!.ecosystem, "npm");
		assert.equal(lodashHigh!.sourceFile, "/worktrees/test/package-lock.json");
		assert.equal(lodashHigh!.summary, "Prototype Pollution in lodash");
		assert.equal(lodashHigh!.isCcCommitMatch, false);

		// Check CRITICAL finding
		const critical = result.findings.find((f) => f.id === "GHSA-zzzz-zzzz-zzzz");
		assert.ok(critical, "critical severity finding should exist");
		assert.equal(critical!.severity, "CRITICAL");
		assert.equal(critical!.packageName, "axios");

		// Check LOW finding
		const low = result.findings.find((f) => f.id === "RUSTSEC-2024-0001");
		assert.ok(low, "low severity finding should exist");
		assert.equal(low!.severity, "LOW");
		assert.equal(low!.ecosystem, "crates.io");
	});

	it("valid JSON with empty results returns clean", () => {
		const result = parseOsvJson(CLEAN_JSON);
		assert.equal(result.status, "clean");
		assert.equal(result.findings.length, 0);
		assert.equal(result.counts.critical, 0);
	});

	it("valid JSON with results but empty packages returns clean", () => {
		const result = parseOsvJson(EMPTY_PACKAGES_JSON);
		assert.equal(result.status, "clean");
		assert.equal(result.findings.length, 0);
	});

	it("valid JSON with packages but no vulnerabilities returns clean", () => {
		const result = parseOsvJson(NO_VULNS_PACKAGES_JSON);
		assert.equal(result.status, "clean");
		assert.equal(result.findings.length, 0);
	});

	it("malformed JSON returns error with parse failure message", () => {
		const result = parseOsvJson("{invalid json}");
		assert.equal(result.status, "error");
		assert.ok(
			result.message!.includes("Failed to parse"),
			`Expected parse failure message, got: ${result.message}`,
		);
	});

	it("null input returns error gracefully", () => {
		const result = parseOsvJson(null);
		assert.equal(result.status, "error");
		assert.ok(result.message!.includes("Empty output"));
	});

	it("undefined input returns error gracefully", () => {
		const result = parseOsvJson(undefined);
		assert.equal(result.status, "error");
		assert.ok(result.message!.includes("Empty output"));
	});

	it("empty string input returns error gracefully", () => {
		const result = parseOsvJson("");
		assert.equal(result.status, "error");
		assert.ok(result.message!.includes("Empty output"));
	});

	it("finding with multiple aliases includes all aliases", () => {
		const result = parseOsvJson(VULN_MULTI_ALIAS_JSON);
		assert.equal(result.status, "vulns_found");
		assert.equal(result.findings.length, 1);
		const finding = result.findings[0]!;
		assert.ok(finding.aliases.includes("CVE-2021-44906"));
		assert.equal(finding.aliases.length, 2); // both CVE and GHSA
	});

	it("C/C++ commit-match finding sets isCcCommitMatch=true", () => {
		const result = parseOsvJson(CC_COMMIT_MATCH_JSON);
		assert.equal(result.status, "vulns_found");
		assert.equal(result.findings.length, 1);
		const finding = result.findings[0]!;
		assert.equal(finding.isCcCommitMatch, true);
		assert.equal(result.ccFindingsFlagged, true);
	});
});
describe("cvss3BaseScore() — CVSS v3.0/3.1 base score (Issue #1620)", () => {
	it("computes official base scores for published/advisory vectors", () => {
		// Values validated against the official FIRST.org calculator:
		// 7.5 (RUSTSEC-2022-0013 regex crate), 9.8 classic, 10.0 log4shell,
		// and the 9.4/9.1/8.6/8.8/8.1 variants cited in the issue research.
		const vectors: Array<[string, number]> = [
			["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H", 7.5],
			["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
			["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0],
			["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:L", 9.4],
			["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N", 9.1],
			["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:L", 8.6],
			["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", 7.5],
			["CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 8.8],
			["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H", 8.8],
			["CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H", 8.1],
		];
		for (const [vector, expected] of vectors) {
			assert.equal(cvss3BaseScore(vector), expected, `base score for ${vector}`);
		}
	});

	it("accepts v3.0 and ignores trailing temporal metrics (log4j GHSA vector /E:H)", () => {
		assert.equal(cvss3BaseScore("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), 9.8);
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H/E:H"), 10.0);
	});

	it("accepts non-canonical metric order (segment tokenizing, not contiguous match)", () => {
		assert.equal(cvss3BaseScore("CVSS:3.1/AC:L/AV:N/PR:N/UI:N/S:U/C:H/I:H/A:H"), 9.8);
	});

	it("returns null for non-v3 input — v2/v4 vectors, numbers, garbage", () => {
		assert.equal(cvss3BaseScore("AV:L/AC:M/Au:N/C:N/I:P/A:C"), null);
		assert.equal(cvss3BaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H"), null);
		assert.equal(cvss3BaseScore("9.8"), null);
		assert.equal(cvss3BaseScore("garbage"), null);
	});

	it("returns null for malformed or invalid metric values", () => {
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:X/I:H/A:H"), null);
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A"), null); // missing A
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/C:H"), null); // dup C
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:X/C:H/I:H/A:H"), null); // bad S
	});

	it("returns null for unknown metric keys and invalid optional values (whitelist)", () => {
		// Unknown metric name on otherwise-valid vector
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/ZZZ:X"), null);
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/FOO:BAR"), null);
		// Invalid value for a valid optional (temporal) metric
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:Z"), null);
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/RL:Q"), null);
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/RC:Y"), null);
		// Invalid value for a valid environmental metric
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/MAV:W"), null);
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/CV:Z"), null);
		// But valid optional values (incl. "X" = Not Defined) still parse
		assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:H/RL:O/RC:C"), 9.8);
		assert.equal(
			cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/MAV:X/MAC:X/MS:U/CR:H"),
			9.8,
		);
	});
});
describe("severityFromBaseScore() — shared bands (Issue #1620)", () => {
	it("maps the official CVSS v3.1 qualitative scale", () => {
		assert.equal(severityFromBaseScore(9.8), "CRITICAL");
		assert.equal(severityFromBaseScore(9.0), "CRITICAL");
		assert.equal(severityFromBaseScore(8.9), "HIGH");
		assert.equal(severityFromBaseScore(7.0), "HIGH");
		assert.equal(severityFromBaseScore(6.9), "MEDIUM");
		assert.equal(severityFromBaseScore(4.0), "MEDIUM");
		assert.equal(severityFromBaseScore(3.9), "LOW");
		assert.equal(severityFromBaseScore(0.1), "LOW");
		assert.equal(severityFromBaseScore(0), null);
	});
});
describe("parseOsvJson() — severity resolution (Issue #1620)", () => {
	it("vector-only critical vuln (no database_specific.severity) is CRITICAL", () => {
		const result = parseOsvJson(VECTOR_ONLY_CRITICAL_JSON);
		assert.equal(result.status, "vulns_found");
		const finding = result.findings[0]!;
		assert.equal(finding.id, "GHSA-vector-only-0001");
		assert.equal(finding.severity, "CRITICAL");
		assert.equal(result.counts.critical, 1);
		assert.equal(result.counts.unknown, 0);
	});

	it("real RUSTSEC vector-only record (base 7.5) maps to HIGH, not UNKNOWN", () => {
		const result = parseOsvJson(RUSTSEC_VECTOR_JSON);
		const finding = result.findings[0]!;
		assert.equal(finding.id, "RUSTSEC-2022-0013");
		assert.equal(finding.severity, "HIGH");
		assert.equal(result.counts.high, 1);
		assert.equal(result.counts.unknown, 0);
	});

	it("GitHub MODERATE vocabulary maps to MEDIUM (elliptic GHSA shape)", () => {
		const result = parseOsvJson(MODERATE_JSON);
		const finding = result.findings[0]!;
		assert.equal(finding.id, "GHSA-r9p9-mrjm-926w");
		assert.equal(finding.severity, "MEDIUM");
		assert.equal(result.counts.medium, 1);
		assert.equal(result.counts.unknown, 0);
	});

	it("severity only under affected[].severity resolves for the matched package", () => {
		const result = parseOsvJson(AFFECTED_ONLY_JSON);
		const finding = result.findings[0]!;
		assert.equal(finding.id, "HSEC-2023-0006");
		assert.equal(finding.severity, "CRITICAL");
		assert.equal(result.counts.critical, 1);
	});

	it("severity under affected[].ecosystem_specific.severity resolves (case-insensitive)", () => {
		const result = parseOsvJson(AFFECTED_ECO_JSON);
		const finding = result.findings[0]!;
		assert.equal(finding.severity, "HIGH");
		assert.equal(result.counts.high, 1);
	});

	it('legacy numeric score fallback still classifies (score: "9.8" → CRITICAL)', () => {
		const result = parseOsvJson(NUMERIC_SCORE_JSON);
		const finding = result.findings[0]!;
		assert.equal(finding.severity, "CRITICAL");
		assert.equal(result.counts.critical, 1);
	});

	it("unparseable severity stays UNKNOWN — fail-closed, never fabricated", () => {
		const result = parseOsvJson(UNPARSEABLE_JSON);
		const finding = result.findings[0]!;
		assert.equal(finding.severity, "UNKNOWN");
		assert.equal(result.counts.unknown, 1);
		assert.equal(result.counts.critical, 0);
	});

	it("malformed vectors (unknown keys / invalid optional values) stay UNKNOWN", () => {
		const result = parseOsvJson(MALFORMED_VECTOR_JSON);
		assert.equal(result.findings.length, 2);
		const unknownKey = result.findings.find((f) => f.id === "GHSA-malformed-0001")!;
		assert.equal(unknownKey.severity, "UNKNOWN");
		const invalidTemporal = result.findings.find((f) => f.id === "GHSA-malformed-0002")!;
		assert.equal(invalidTemporal.severity, "UNKNOWN");
		assert.equal(result.counts.unknown, 2);
		assert.equal(result.counts.critical, 0); // gate must NOT trip on malformed metadata
	});

	it("CVSS-typed entry with vocabulary string stays UNKNOWN (no fabricated CRITICAL)", () => {
		const result = parseOsvJson(CVSS_TYPE_VOCAB_FABRICATION_JSON);
		const finding = result.findings[0]!;
		assert.equal(finding.id, "GHSA-fabricate-0001");
		assert.equal(finding.severity, "UNKNOWN");
		assert.equal(result.counts.critical, 0);
		assert.equal(result.counts.unknown, 1);
	});

	it("numeric fallback restricted to CVSS_V3 within 0–10 (audit: V4 numeric + out-of-range stay UNKNOWN)", () => {
		const result = parseOsvJson(CVSS_NUMERIC_BOUNDARY_JSON);
		assert.equal(result.findings.length, 4);
		const byId = Object.fromEntries(result.findings.map((f) => [f.id, f.severity]));
		// Unsupported CVSS types with a bare numeric score must NOT become CRITICAL
		assert.equal(byId["GHSA-v4-numeric-0001"], "UNKNOWN");
		assert.equal(byId["GHSA-v2-numeric-0002"], "UNKNOWN");
		// Out-of-range CVSS_V3 numeric score must NOT become CRITICAL
		assert.equal(byId["GHSA-over-range-0003"], "UNKNOWN");
		// Top-of-range boundary still classifies
		assert.equal(byId["GHSA-range-boundary-0004"], "CRITICAL");
		assert.equal(result.counts.critical, 1);
		assert.equal(result.counts.unknown, 3);
	});

	it("affected[] severity resolved by matching ecosystem, not first name match", () => {
		const result = parseOsvJson(AFFECTED_ECOSYSTEM_MISMATCH_JSON);
		const finding = result.findings[0]!;
		assert.equal(finding.severity, "CRITICAL");
		assert.equal(result.counts.critical, 1);
	});

	it("foreign-ecosystem affected[] entry is not applied (stays UNKNOWN)", () => {
		const result = parseOsvJson(AFFECTED_FOREIGN_ECOSYSTEM_JSON);
		const finding = result.findings[0]!;
		assert.equal(finding.severity, "UNKNOWN");
		assert.equal(result.counts.unknown, 1);
	});
});
describe("bucketBySeverity()", () => {
	it("single finding per severity bucket returns correct counts", () => {
		const findings: OsvFinding[] = [
			{
				id: "1",
				aliases: [],
				severity: "CRITICAL",
				packageName: "a",
				packageVersion: "1",
				ecosystem: "npm",
				sourceFile: "f",
				summary: "",
				isCcCommitMatch: false,
			},
			{
				id: "2",
				aliases: [],
				severity: "HIGH",
				packageName: "a",
				packageVersion: "1",
				ecosystem: "npm",
				sourceFile: "f",
				summary: "",
				isCcCommitMatch: false,
			},
			{
				id: "3",
				aliases: [],
				severity: "HIGH",
				packageName: "b",
				packageVersion: "1",
				ecosystem: "npm",
				sourceFile: "f",
				summary: "",
				isCcCommitMatch: false,
			},
			{
				id: "4",
				aliases: [],
				severity: "MEDIUM",
				packageName: "c",
				packageVersion: "1",
				ecosystem: "npm",
				sourceFile: "f",
				summary: "",
				isCcCommitMatch: false,
			},
			{
				id: "5",
				aliases: [],
				severity: "LOW",
				packageName: "d",
				packageVersion: "1",
				ecosystem: "npm",
				sourceFile: "f",
				summary: "",
				isCcCommitMatch: false,
			},
			{
				id: "6",
				aliases: [],
				severity: "UNKNOWN",
				packageName: "e",
				packageVersion: "1",
				ecosystem: "npm",
				sourceFile: "f",
				summary: "",
				isCcCommitMatch: false,
			},
		];
		const counts = bucketBySeverity(findings);
		assert.equal(counts.critical, 1);
		assert.equal(counts.high, 2);
		assert.equal(counts.medium, 1);
		assert.equal(counts.low, 1);
		assert.equal(counts.unknown, 1);
	});

	it("empty findings array returns all zeros", () => {
		const counts = bucketBySeverity([]);
		assert.equal(counts.critical, 0);
		assert.equal(counts.high, 0);
		assert.equal(counts.medium, 0);
		assert.equal(counts.low, 0);
		assert.equal(counts.unknown, 0);
	});

	it("mixed severities from real osv-scanner data returns correct counts", () => {
		const result = parseOsvJson(VULNS_JSON);
		assert.equal(result.counts.critical, 1); // axios
		assert.equal(result.counts.high, 1); // lodash high
		assert.equal(result.counts.medium, 1); // lodash medium
		assert.equal(result.counts.low, 1); // openssl-sys
		assert.equal(result.counts.unknown, 0);
	});

	it("ccFindingsFlagged set to true when any finding has isCcCommitMatch", () => {
		const result = parseOsvJson(CC_COMMIT_MATCH_JSON);
		assert.equal(result.ccFindingsFlagged, true);
	});

	it("ccFindingsFlagged false when no C/C++ findings", () => {
		const result = parseOsvJson(VULNS_JSON);
		assert.equal(result.ccFindingsFlagged, false);
	});
});
