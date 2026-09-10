/**
 * Tests for checks/osv-scanner.ts — pre-audit vulnerability scanning gate
 *
 * Covers: parseOsvJson, bucketBySeverity, buildVulnContext, runVulnScan
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/checks/osv-scanner.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	type OsvFinding,
	type OsvScanResult,
	parseOsvJson,
	bucketBySeverity,
	buildVulnContext,
	runVulnScan,
	cvss3BaseScore,
	severityFromBaseScore,
} from "../../checks/osv-scanner.ts";
import type { ExecFn } from "../../checks/shared.ts";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════

const CLEAN_JSON = JSON.stringify({ results: [] });

const VULNS_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-xxxx-xxxx-xxxx",
							aliases: ["CVE-2024-1111"],
							summary: "Prototype Pollution in lodash",
							database_specific: { severity: "HIGH" },
						},
						{
							id: "GHSA-yyyy-yyyy-yyyy",
							aliases: ["CVE-2024-2222"],
							summary: "Regular Expression DoS in lodash",
							database_specific: { severity: "MEDIUM" },
						},
					],
					groups: [{ ids: ["GHSA-xxxx-xxxx-xxxx"] }, { ids: ["GHSA-yyyy-yyyy-yyyy"] }],
				},
				{
					package: { name: "axios", version: "0.21.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-zzzz-zzzz-zzzz",
							aliases: ["CVE-2024-3333"],
							summary: "Server-Side Request Forgery in axios",
							database_specific: { severity: "CRITICAL" },
						},
					],
					groups: [{ ids: ["GHSA-zzzz-zzzz-zzzz"] }],
				},
			],
		},
		{
			source: { path: "/worktrees/test/Cargo.lock", type: "lockfile" },
			packages: [
				{
					package: { name: "openssl-sys", version: "0.9.60", ecosystem: "crates.io" },
					vulnerabilities: [
						{
							id: "RUSTSEC-2024-0001",
							aliases: ["CVE-2024-4444"],
							summary: "Buffer overflow in openssl-sys",
							database_specific: { severity: "LOW" },
						},
					],
					groups: [{ ids: ["RUSTSEC-2024-0001"] }],
				},
			],
		},
	],
});

const VULN_MULTI_ALIAS_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "minimist", version: "1.2.5", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-vh95-9grf-7q3r",
							aliases: ["CVE-2021-44906", "GHSA-vh95-9grf-7q3r"],
							summary: "Prototype Pollution in minimist",
							database_specific: { severity: "CRITICAL" },
						},
					],
					groups: [{ ids: ["GHSA-vh95-9grf-7q3r"] }],
				},
			],
		},
	],
});

const CC_COMMIT_MATCH_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/vendored/curl", type: "source" },
			packages: [
				{
					package: { name: "curl", version: "7.79.0", ecosystem: "c" },
					vulnerabilities: [
						{
							id: "GHSA-cccc-cccc-cccc",
							aliases: ["CVE-2024-5555"],
							summary: "Heap buffer overflow in curl",
							database_specific: { severity: "HIGH" },
						},
					],
					groups: [{ ids: ["GHSA-cccc-cccc-cccc"] }],
				},
			],
		},
	],
});

const EMPTY_PACKAGES_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [],
		},
	],
});

const NO_VULNS_PACKAGES_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "lodash", version: "4.17.21", ecosystem: "npm" },
					vulnerabilities: [],
					groups: [],
				},
			],
		},
	],
});

// ── Issue #1620 fixtures: CVSS-vector severity resolution ─────────
// Real osv.dev records: vector-only (no database_specific.severity),
// GitHub MODERATE vocabulary, severity under affected[], legacy numeric.

/** GHSA-style record: severity only in severity[] as a CVSS_V3 vector. */
const VECTOR_ONLY_CRITICAL_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "axios", version: "0.21.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-vector-only-0001",
							aliases: ["CVE-2024-9991"],
							summary: "Critical vuln with vector-only metadata",
							// No database_specific.severity — severity[] only (osv.dev shape)
							severity: [
								{
									type: "CVSS_V3",
									score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
								},
							],
						},
					],
					groups: [{ ids: ["GHSA-vector-only-0001"] }],
				},
			],
		},
	],
});

/** Real RUSTSEC-2022-0013 shape: vector-only, C:N/I:N/A:H → 7.5 → HIGH. */
const RUSTSEC_VECTOR_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/Cargo.lock", type: "lockfile" },
			packages: [
				{
					package: { name: "regex", version: "1.5.4", ecosystem: "crates.io" },
					vulnerabilities: [
						{
							id: "RUSTSEC-2022-0013",
							aliases: ["CVE-2022-24713", "GHSA-m5pq-gvj9-9vr8"],
							summary: "Regex DoS",
							severity: [
								{
									type: "CVSS_V3",
									score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
								},
							],
						},
					],
					groups: [{ ids: ["RUSTSEC-2022-0013"] }],
				},
			],
		},
	],
});

/** GitHub Advisory vocabulary (elliptic GHSA-r9p9-mrjm-926w is MODERATE). */
const MODERATE_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "elliptic", version: "6.5.3", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-r9p9-mrjm-926w",
							aliases: ["CVE-2020-28498"],
							summary: "Elliptic broken crypto",
							database_specific: { severity: "MODERATE" },
							severity: [
								{
									type: "CVSS_V3",
									score: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:H/I:N/A:N",
								},
							],
						},
					],
					groups: [{ ids: ["GHSA-r9p9-mrjm-926w"] }],
				},
			],
		},
	],
});

/** OSV schema: package-level severity lives under affected[] when set. */
const AFFECTED_ONLY_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "hs-malware-detector", version: "1.0.0", ecosystem: "pip" },
					vulnerabilities: [
						{
							id: "HSEC-2023-0006",
							aliases: [],
							summary: "Malware in PyPI package",
							// No top-level severity — vector only under affected[].severity
							affected: [
								{
									package: { name: "hs-malware-detector", ecosystem: "pip" },
									severity: [
										{
											type: "CVSS_V3",
											score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
										},
									],
								},
							],
						},
					],
					groups: [{ ids: ["HSEC-2023-0006"] }],
				},
			],
		},
	],
});

/** Severity as ecosystem_specific.severity on the affected entry (RUSTSEC style). */
const AFFECTED_ECO_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/Cargo.lock", type: "lockfile" },
			packages: [
				{
					package: { name: "serde", version: "1.0.0", ecosystem: "crates.io" },
					vulnerabilities: [
						{
							id: "RUSTSEC-2025-0001",
							aliases: [],
							summary: "Severity in ecosystem_specific",
							affected: [
								{
									package: { name: "serde", ecosystem: "crates.io" },
									ecosystem_specific: { severity: "high" },
								},
							],
						},
					],
					groups: [{ ids: ["RUSTSEC-2025-0001"] }],
				},
			],
		},
	],
});

/** Legacy numeric score record (osv-scanner sometimes emits score: "9.8"). */
const NUMERIC_SCORE_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "legacy-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-numeric-0001",
							aliases: [],
							summary: "Numeric score vuln",
							severity: [{ type: "CVSS_V3", score: "9.8" }],
						},
					],
					groups: [{ ids: ["GHSA-numeric-0001"] }],
				},
			],
		},
	],
});

/** Fail-closed: a CVSS-typed entry whose score is neither a vector nor a
 * number must stay UNKNOWN — it must NOT fall through to vocabulary mapping.
 * { type: "CVSS_V3", score: "CRITICAL" } previously fabricated CRITICAL. */
const CVSS_TYPE_VOCAB_FABRICATION_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "fabricate-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-fabricate-0001",
							aliases: [],
							summary: "Malformed CVSS_V3 entry with a vocabulary string",
							severity: [{ type: "CVSS_V3", score: "CRITICAL" }],
						},
					],
					groups: [{ ids: ["GHSA-fabricate-0001"] }],
				},
			],
		},
	],
});

/** affected[] holds same-named packages across ecosystems; severity must come
 * from the entry whose ecosystem matches the scanned package, not the first
 * name match. */
const AFFECTED_ECOSYSTEM_MISMATCH_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/requirements.txt", type: "lockfile" },
			packages: [
				{
					package: { name: "requests", version: "2.0.0", ecosystem: "PyPI" },
					vulnerabilities: [
						{
							id: "PYSEC-2025-0001",
							aliases: [],
							summary: "Per-ecosystem package-level severity",
							affected: [
								{
									package: { name: "requests", ecosystem: "npm" },
									database_specific: { severity: "LOW" },
								},
								{
									package: { name: "requests", ecosystem: "PyPI" },
									database_specific: { severity: "CRITICAL" },
								},
							],
						},
					],
					groups: [{ ids: ["PYSEC-2025-0001"] }],
				},
			],
		},
	],
});

/** Only a foreign-ecosystem affected entry exists — it must NOT be applied,
 * or cross-ecosystem metadata could downgrade/fabricate a finding. */
const AFFECTED_FOREIGN_ECOSYSTEM_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/requirements.txt", type: "lockfile" },
			packages: [
				{
					package: { name: "requests", version: "2.0.0", ecosystem: "PyPI" },
					vulnerabilities: [
						{
							id: "PYSEC-2025-0002",
							aliases: [],
							summary: "Foreign-ecosystem affected entry only",
							affected: [
								{
									package: { name: "requests", ecosystem: "npm" },
									database_specific: { severity: "CRITICAL" },
								},
							],
						},
					],
					groups: [{ ids: ["PYSEC-2025-0002"] }],
				},
			],
		},
	],
});

/** Fail-closed: a vector with unknown metric keys or invalid optional
 * values must stay UNKNOWN — it must not compute a valid score from
 * malformed segments and fabricate a CRITICAL finding. */
const MALFORMED_VECTOR_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "malformed-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-malformed-0001",
							aliases: [],
							summary: "Unknown metric key in vector",
							severity: [
								{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/ZZZ:X" },
							],
						},
					],
					groups: [{ ids: ["GHSA-malformed-0001"] }],
				},
				{
					package: { name: "malformed-pkg2", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-malformed-0002",
							aliases: [],
							summary: "Invalid temporal metric value",
							severity: [
								{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:Z" },
							],
						},
					],
					groups: [{ ids: ["GHSA-malformed-0002"] }],
				},
			],
		},
	],
});

/** Fail-closed: unparseable severity must stay UNKNOWN, never fabricated. */
const UNPARSEABLE_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "old-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "CVE-2009-0001",
							aliases: [],
							summary: "CVSS v2 vector — documented gap",
							severity: [{ type: "CVSS_V2", score: "AV:L/AC:M/Au:N/C:N/I:P/A:C" }],
						},
					],
					groups: [{ ids: ["CVE-2009-0001"] }],
				},
			],
		},
	],
});

/** Fail-closed: the legacy bare-number fallback applies only to CVSS_V3
 * entries and only within the CVSS 0–10 range. Unsupported CVSS types with a
 * numeric score and out-of-range scores must stay UNKNOWN, never CRITICAL. */
const CVSS_NUMERIC_BOUNDARY_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "v4-numeric-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-v4-numeric-0001",
							aliases: [],
							summary: "CVSS_V4 legacy numeric score",
							severity: [{ type: "CVSS_V4", score: "9.8" }],
						},
					],
					groups: [{ ids: ["GHSA-v4-numeric-0001"] }],
				},
				{
					package: { name: "v2-numeric-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-v2-numeric-0002",
							aliases: [],
							summary: "CVSS_V2 legacy numeric score",
							severity: [{ type: "CVSS_V2", score: "9.8" }],
						},
					],
					groups: [{ ids: ["GHSA-v2-numeric-0002"] }],
				},
				{
					package: { name: "over-range-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-over-range-0003",
							aliases: [],
							summary: "CVSS_V3 score above the 0–10 range",
							severity: [{ type: "CVSS_V3", score: "11" }],
						},
					],
					groups: [{ ids: ["GHSA-over-range-0003"] }],
				},
				{
					package: { name: "range-boundary-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-range-boundary-0004",
							aliases: [],
							summary: "CVSS_V3 score at the top of the valid range",
							severity: [{ type: "CVSS_V3", score: "10" }],
						},
					],
					groups: [{ ids: ["GHSA-range-boundary-0004"] }],
				},
			],
		},
	],
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Pure functions — parseOsvJson
// ═══════════════════════════════════════════════════════════════════════

describe("parseOsvJson()", () => {
	it("valid JSON with vulnerabilities returns vulns_found with correct findings", () => {
		const result = parseOsvJson(VULNS_JSON);
		assert.equal(result.status, "vulns_found");
		assert.equal(result.findings.length, 4);

		// Check first finding: lodash HIGH
		const lodashHigh = result.findings.find(
			(f) => f.id === "GHSA-xxxx-xxxx-xxxx",
		);
		assert.ok(lodashHigh, "lodash high severity finding should exist");
		assert.equal(lodashHigh!.severity, "HIGH");
		assert.equal(lodashHigh!.packageName, "lodash");
		assert.equal(lodashHigh!.packageVersion, "4.17.20");
		assert.equal(lodashHigh!.ecosystem, "npm");
		assert.equal(lodashHigh!.sourceFile, "/worktrees/test/package-lock.json");
		assert.equal(lodashHigh!.summary, "Prototype Pollution in lodash");
		assert.equal(lodashHigh!.isCcCommitMatch, false);

		// Check CRITICAL finding
		const critical = result.findings.find(
			(f) => f.id === "GHSA-zzzz-zzzz-zzzz",
		);
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
		assert.ok(result.message!.includes("Failed to parse"), 
			`Expected parse failure message, got: ${result.message}`);
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

// ═══════════════════════════════════════════════════════════════════════
// Issue #1620: CVSS vector severity resolution
// (vector branch was unreachable dead code — vector-only findings were
// mis-bucketed UNKNOWN and never tripped the blocking gate)
// ═══════════════════════════════════════════════════════════════════════

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

	it("legacy numeric score fallback still classifies (score: \"9.8\" → CRITICAL)", () => {
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

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Pure functions — bucketBySeverity
// ═══════════════════════════════════════════════════════════════════════

describe("bucketBySeverity()", () => {
	it("single finding per severity bucket returns correct counts", () => {
		const findings: OsvFinding[] = [
			{
				id: "1", aliases: [], severity: "CRITICAL",
				packageName: "a", packageVersion: "1", ecosystem: "npm",
				sourceFile: "f", summary: "", isCcCommitMatch: false,
			},
			{
				id: "2", aliases: [], severity: "HIGH",
				packageName: "a", packageVersion: "1", ecosystem: "npm",
				sourceFile: "f", summary: "", isCcCommitMatch: false,
			},
			{
				id: "3", aliases: [], severity: "HIGH",
				packageName: "b", packageVersion: "1", ecosystem: "npm",
				sourceFile: "f", summary: "", isCcCommitMatch: false,
			},
			{
				id: "4", aliases: [], severity: "MEDIUM",
				packageName: "c", packageVersion: "1", ecosystem: "npm",
				sourceFile: "f", summary: "", isCcCommitMatch: false,
			},
			{
				id: "5", aliases: [], severity: "LOW",
				packageName: "d", packageVersion: "1", ecosystem: "npm",
				sourceFile: "f", summary: "", isCcCommitMatch: false,
			},
			{
				id: "6", aliases: [], severity: "UNKNOWN",
				packageName: "e", packageVersion: "1", ecosystem: "npm",
				sourceFile: "f", summary: "", isCcCommitMatch: false,
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

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Pure functions — buildVulnContext
// ═══════════════════════════════════════════════════════════════════════

describe("buildVulnContext()", () => {
	it("clean result returns short message", () => {
		const result: OsvScanResult = {
			status: "clean",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
			ccFindingsFlagged: false,
		};
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("No vulnerabilities found"));
	});

	it("vulns found returns formatted markdown with severity counts", () => {
		const result = parseOsvJson(VULNS_JSON);
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("vulnerability(ies) found"));
		assert.ok(ctx.includes("Critical"));
		assert.ok(ctx.includes("High"));
		assert.ok(ctx.includes("Medium"));
		assert.ok(ctx.includes("Low"));
		assert.ok(ctx.includes("GHSA-xxxx-xxxx-xxxx"));
		assert.ok(ctx.includes("lodash@4.17.20"));
		// Also verify severity breakdown line contains lowercase severity labels
		assert.ok(ctx.includes("critical") || ctx.includes("high"));
	});

	it("error result returns error message", () => {
		const result: OsvScanResult = {
			status: "error",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
			ccFindingsFlagged: false,
			message: "osv-scanner crashed",
		};
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("osv-scanner crashed"));
	});

	it("no_osv_scanner returns specific message", () => {
		const result: OsvScanResult = {
			status: "no_osv_scanner",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
			ccFindingsFlagged: false,
		};
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("not installed"));
	});

	it("no_lockfiles returns specific message", () => {
		const result: OsvScanResult = {
			status: "no_lockfiles",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
			ccFindingsFlagged: false,
		};
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("No lockfiles found"));
	});

	it("findings with ccFindingsFlagged includes note about reliability", () => {
		const result = parseOsvJson(CC_COMMIT_MATCH_JSON);
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("C/C++"));
		assert.ok(ctx.includes("less reliable"));
	});

	it("UNKNOWN severity finding renders as ⚪ Unknown via ?? fallback", () => {
		const findings: OsvFinding[] = [
			{
				id: "GHSA-unknown-1111-1111",
				aliases: ["CVE-2024-9999"],
				severity: "UNKNOWN",
				packageName: "some-package",
				packageVersion: "1.0.0",
				ecosystem: "npm",
				sourceFile: "/worktrees/test/package-lock.json",
				summary: "Unspecified vulnerability",
				isCcCommitMatch: false,
			},
		];
		const result: OsvScanResult = {
			status: "vulns_found",
			findings,
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 1 },
			ccFindingsFlagged: false,
		};
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("⚪ Unknown"), `Expected ⚪ Unknown in context, got: ${ctx}`);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3b: Severity label lookup
// ═══════════════════════════════════════════════════════════════════════

describe("buildVulnContext() — severity labels", () => {
	it("CRITICAL finding renders 🔴 Critical", () => {
		const result = parseOsvJson(VULNS_JSON);
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("🔴 Critical"), "CRITICAL should render with 🔴 Critical");
	});

	it("HIGH finding renders 🟠 High", () => {
		const result = parseOsvJson(VULNS_JSON);
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("🟠 High"), "HIGH should render with 🟠 High");
	});

	it("MEDIUM finding renders 🟡 Medium", () => {
		const result = parseOsvJson(VULNS_JSON);
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("🟡 Medium"), "MEDIUM should render with 🟡 Medium");
	});

	it("LOW finding renders 🟢 Low", () => {
		const result = parseOsvJson(VULNS_JSON);
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("🟢 Low"), "LOW should render with 🟢 Low");
	});

	it("UNKNOWN severity falls through to ⚪ Unknown", () => {
		// Create a result with an UNKNOWN finding
		const unknownJson = JSON.stringify({
			results: [{
				source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
				packages: [{
					package: { name: "test-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [{
						id: "GHSA-uuuu-uuuu-uuuu",
						aliases: [],
						summary: "Unknown severity vuln",
					}],
					groups: [{ ids: ["GHSA-uuuu-uuuu-uuuu"] }],
				}],
			}],
		});
		const result = parseOsvJson(unknownJson);
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("⚪ Unknown"), "UNKNOWN should render with ⚪ Unknown");
	});

	it("all severity labels appear in a mixed-severity output", () => {
		const result = parseOsvJson(VULNS_JSON);
		const ctx = buildVulnContext(result);
		assert.ok(ctx.includes("🔴 Critical"));
		assert.ok(ctx.includes("🟠 High"));
		assert.ok(ctx.includes("🟡 Medium"));
		assert.ok(ctx.includes("🟢 Low"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Exec orchestration — runVulnScan
// ═══════════════════════════════════════════════════════════════════════

describe("runVulnScan()", () => {
	it("exit code 0 with clean JSON returns clean", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			[{ code: 0, stdout: CLEAN_JSON, stderr: "" }],
			calls,
		);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "clean");
		assert.equal(result.findings.length, 0);
	});

	it("exit code 1 with vulns JSON returns vulns_found", async () => {
		const exec = createMockExec(
			[{ code: 1, stdout: VULNS_JSON, stderr: "" }],
		);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "vulns_found");
		assert.equal(result.findings.length, 4);
	});

	it("exit code 127 returns error with stderr", async () => {
		const exec = createMockExec(
			[{ code: 127, stdout: "", stderr: "osv-scanner: unknown flag" }],
		);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "error");
		assert.ok(result.message!.includes("unknown flag"));
	});

	it("exit code 128 returns no_lockfiles", async () => {
		const exec = createMockExec(
			[{ code: 128, stdout: "", stderr: "No lockfiles found" }],
		);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "no_lockfiles");
	});

	it("ENOENT returns no_osv_scanner", async () => {
		const enoent = new Error("spawn osv-scanner ENOENT");
		(enoent as NodeJS.ErrnoException).code = "ENOENT";
		const exec = createRejectingExec(enoent);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "no_osv_scanner");
	});

	it("exec throws unexpected error returns error", async () => {
		const exec = createRejectingExec(new Error("connection refused"));
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "error");
		assert.ok(result.message!.includes("connection refused"));
	});

	it("includes --recursive and --format json in args", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			[{ code: 0, stdout: CLEAN_JSON, stderr: "" }],
			calls,
		);
		await runVulnScan(exec, "/worktrees/test");
		assert.ok(calls.length >= 1);
		const args = calls[0]!.args;
		assert.ok(args.includes("--recursive"), `expected --recursive in args: ${args}`);
		assert.ok(args.includes("--format"), `expected --format in args: ${args}`);
		assert.ok(args.includes("json"), `expected json in args: ${args}`);
	});

	it("worktree path passed as positional arg", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			[{ code: 0, stdout: CLEAN_JSON, stderr: "" }],
			calls,
		);
		await runVulnScan(exec, "/my/worktree");
		assert.ok(calls[0]!.args.includes("/my/worktree"));
	});

	it("uses V2 syntax: scan source subcommands", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			[{ code: 0, stdout: CLEAN_JSON, stderr: "" }],
			calls,
		);
		await runVulnScan(exec, "/worktrees/test");
		const args = calls[0]!.args;
		assert.equal(args[0], "scan");
		assert.equal(args[1], "source");
	});

	it("timeout default is 60s (60000ms)", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			[{ code: 0, stdout: CLEAN_JSON, stderr: "" }],
			calls,
		);
		await runVulnScan(exec, "/worktrees/test");
		const opts = calls[0]!.opts as Record<string, unknown> | undefined;
		assert.equal(opts?.timeout, 60000);
	});

	it("timeout option from opts is used", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			[{ code: 0, stdout: CLEAN_JSON, stderr: "" }],
			calls,
		);
		await runVulnScan(exec, "/worktrees/test", { timeoutSec: 30 });
		const opts = calls[0]!.opts as Record<string, unknown> | undefined;
		assert.equal(opts?.timeout, 30000);
	});

	it("configPath option adds --config flag", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			[{ code: 0, stdout: CLEAN_JSON, stderr: "" }],
			calls,
		);
		await runVulnScan(exec, "/worktrees/test", { configPath: "/worktrees/test/osv-scanner.toml" });
		const args = calls[0]!.args;
		const configIdx = args.indexOf("--config");
		assert.notEqual(configIdx, -1, "expected --config in args");
		assert.equal(args[configIdx + 1], "/worktrees/test/osv-scanner.toml");
	});

	it("exit code 0 with stdout empty returns clean (empty stdout = no findings)", async () => {
		const exec = createMockExec(
			[{ code: 0, stdout: "", stderr: "" }],
		);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "clean"); // Exit 0 + empty stdout = clean
		assert.equal(result.findings.length, 0);
	});

	it("calls osv-scanner with correct command", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			[{ code: 0, stdout: CLEAN_JSON, stderr: "" }],
			calls,
		);
		await runVulnScan(exec, "/worktrees/test");
		assert.equal(calls[0]!.cmd, "osv-scanner");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: Pipeline integration tests (text scan — already covered by
// the audit.ts and handler.ts modifications below)
// ═══════════════════════════════════════════════════════════════════════

// Note: Phase 5 (audit.ts), Phase 6 (handler.ts/stages.ts), Phase 7 (config types),
// Phase 8 (Dockerfile), Phase 9 (docs) are verified via text scan of the modified
// files in the pipeline, not through unit tests.
