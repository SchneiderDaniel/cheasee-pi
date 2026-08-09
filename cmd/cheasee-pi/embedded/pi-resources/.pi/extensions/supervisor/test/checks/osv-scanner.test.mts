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
