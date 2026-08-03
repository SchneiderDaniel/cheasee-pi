/**
 * Entity tests for pipeline/audit/pre-gates.ts — the six pre-transition
 * gates. Check runners are injected via deps (fakes returning canned
 * results); assertions pin failureText byte-exact per gate semantics.
 *
 * Issue #1407: gates extracted from audit.ts; behavior must be identical.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/pre-gates.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	runCiGate,
	runDeadCodeGate,
	runDuplicateGate,
	runOsvGate,
	runPackageSafetyGate,
	runTraceabilityGate,
	type PreGateDeps,
} from "../pipeline/audit/pre-gates.ts";
import type { SupervisorConfig } from "../config/types.ts";
import type { ExecFn } from "../pipeline/helpers.ts";
import type { CiPollResult } from "../checks/ci-gating.ts";
import type { DuplicateCodeResult } from "../checks/duplicate-code.ts";
import type { DeadCodeResult } from "../checks/dead-code.ts";
import type { OsvScanResult } from "../checks/osv-scanner.ts";
import type { PackageSafetyAuditResult } from "../checks/package-safety.ts";
import type { TraceabilityGap } from "../checks/requirements-traceability.ts";

// ── Fixtures / helpers ─────────────────────────────────────────────

function makeDeps(overrides: Partial<PreGateDeps> = {}): PreGateDeps {
	return {
		pi: {} as unknown as ExtensionAPI,
		execFn: (async () => ({ code: 0, stdout: "", stderr: "" })) as unknown as ExecFn,
		ui: { notify: () => {} } as unknown as ExtensionCommandContext["ui"],
		repo: "owner/repo",
		branch: "feat/issue-1407",
		filteredData: { body: "", comments: [] },
		issueTitle: "test issue",
		...overrides,
	};
}

function makeConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
	return { ciGatingTimeoutSec: 30, defaultBranch: "main", ...overrides } as SupervisorConfig;
}

const CLEAN_DUP: DuplicateCodeResult = {
	status: "clean",
	clones: [],
	totalDuplicateLines: 0,
	changedFilesScanned: [],
};

const DEAD_FOUND: DeadCodeResult = {
	status: "dead_found",
	findings: [
		{
			file: "src/legacy.ts",
			line: 12,
			type: "unused-export",
			symbol: "legacyHelper",
			confidence: "100%",
		},
	],
	totalDeadLines: 3,
	changedFilesScanned: ["src/legacy.ts"],
};

const VULNS_FOUND: OsvScanResult = {
	status: "vulns_found",
	findings: [
		{
			id: "GHSA-xxxx",
			aliases: ["CVE-2024-0001"],
			severity: "CRITICAL",
			packageName: "left-pad",
			packageVersion: "1.0.0",
			ecosystem: "npm",
			sourceFile: "package-lock.json",
			summary: "critical vuln",
			isCcCommitMatch: false,
		},
	],
	counts: { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 },
	message: undefined,
	ccFindingsFlagged: false,
};

const CLEAN_OSV: OsvScanResult = {
	status: "clean",
	findings: [],
	counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
	message: undefined,
	ccFindingsFlagged: false,
};

const ciResult = (status: CiPollResult["status"], message = "ci message"): CiPollResult => ({
	status,
	checks: [],
	message,
});

// ── runCiGate ──────────────────────────────────────────────────────

describe("runCiGate (Issue #1407 split)", () => {
	it("failing → failureText `--- CI Gate ---\\n<message>`", async () => {
		const notifyCalls: Array<[string, string]> = [];
		const deps = makeDeps({
			ui: {
				notify: (msg: string, level: string) => notifyCalls.push([msg, level]),
			} as unknown as ExtensionCommandContext["ui"],
			pollCiChecksFn: async () =>
				ciResult("failing", "2 check(s) failed: build, lint") as Awaited<
					ReturnType<NonNullable<PreGateDeps["pollCiChecksFn"]>>
				>,
		});
		const result = await runCiGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, "--- CI Gate ---\n2 check(s) failed: build, lint");
		assert.equal(notifyCalls.length, 1);
		assert.ok(notifyCalls[0]![0].includes("CI checks failing"));
		assert.equal(notifyCalls[0]![1], "warning");
	});

	it("pending → null with warning notify", async () => {
		const notifyCalls: Array<[string, string]> = [];
		const deps = makeDeps({
			ui: {
				notify: (msg: string, level: string) => notifyCalls.push([msg, level]),
			} as unknown as ExtensionCommandContext["ui"],
			pollCiChecksFn: async () =>
				ciResult("pending") as Awaited<ReturnType<NonNullable<PreGateDeps["pollCiChecksFn"]>>>,
		});
		const result = await runCiGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
		assert.equal(notifyCalls.length, 1);
		assert.equal(notifyCalls[0]![1], "warning");
	});

	it("error → null with warning notify", async () => {
		const deps = makeDeps({
			pollCiChecksFn: async () =>
				ciResult("error") as Awaited<ReturnType<NonNullable<PreGateDeps["pollCiChecksFn"]>>>,
		});
		const result = await runCiGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
	});

	it("unconfigured → null, silent", async () => {
		const deps = makeDeps({
			pollCiChecksFn: async () =>
				ciResult("unconfigured") as Awaited<ReturnType<NonNullable<PreGateDeps["pollCiChecksFn"]>>>,
		});
		const result = await runCiGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
	});

	it("ciGatingTimeoutSec unset/0 → null and runner NOT invoked", async () => {
		let invoked = false;
		const deps = makeDeps({
			pollCiChecksFn: async () => {
				invoked = true;
				return ciResult("failing") as Awaited<
					ReturnType<NonNullable<PreGateDeps["pollCiChecksFn"]>>
				>;
			},
		});
		const disabled = await runCiGate(deps, makeConfig({ ciGatingTimeoutSec: 0 }), "/wt");
		assert.equal(disabled.failureText, null);
		assert.equal(invoked, false, "runner must not run when CI gating disabled");
	});
});

// ── runDuplicateGate ───────────────────────────────────────────────

describe("runDuplicateGate (Issue #1407 split)", () => {
	it("non-blocking: failureText always null, dupResult surfaced", async () => {
		const deps = makeDeps({
			runDuplicateCheckFn: async () =>
				CLEAN_DUP as Awaited<ReturnType<NonNullable<PreGateDeps["runDuplicateCheckFn"]>>>,
		});
		const result = await runDuplicateGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
		assert.equal(result.dupResult, CLEAN_DUP);
	});

	it("duplicates_found still notifies but does not block", async () => {
		const notifyCalls: Array<[string, string]> = [];
		const deps = makeDeps({
			ui: {
				notify: (msg: string, level: string) => notifyCalls.push([msg, level]),
			} as unknown as ExtensionCommandContext["ui"],
			runDuplicateCheckFn: async () =>
				({
					status: "duplicates_found",
					clones: [
						{
							type: "exact",
							lines: 8,
							similarity: 100,
							locations: [{ file: "a.ts", startLine: 1, endLine: 8 }],
						},
					],
					totalDuplicateLines: 8,
					changedFilesScanned: ["a.ts"],
				}) as Awaited<ReturnType<NonNullable<PreGateDeps["runDuplicateCheckFn"]>>>,
		});
		const result = await runDuplicateGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
		assert.equal(notifyCalls.length, 1);
		assert.equal(notifyCalls[0]![1], "warning");
	});
});

// ── runDeadCodeGate ────────────────────────────────────────────────

describe("runDeadCodeGate (Issue #1407 split)", () => {
	it("dead_found → failureText `--- Dead Code Gate ---\\n<context>`", async () => {
		const deps = makeDeps({
			runDeadCodeCheckFn: async () =>
				DEAD_FOUND as Awaited<ReturnType<NonNullable<PreGateDeps["runDeadCodeCheckFn"]>>>,
		});
		const result = await runDeadCodeGate(deps, makeConfig(), "/wt");
		assert.ok(result.failureText?.startsWith("--- Dead Code Gate ---\n"));
		assert.ok(result.failureText?.includes("1 dead code finding(s) found (3 total lines)"));
		assert.equal(result.deadResult, DEAD_FOUND);
	});

	it("no_knip → null", async () => {
		const deps = makeDeps({
			runDeadCodeCheckFn: async () =>
				({
					status: "no_knip",
					findings: [],
					totalDeadLines: 0,
					changedFilesScanned: [],
				}) as Awaited<ReturnType<NonNullable<PreGateDeps["runDeadCodeCheckFn"]>>>,
		});
		const result = await runDeadCodeGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
	});

	it("error → null", async () => {
		const deps = makeDeps({
			runDeadCodeCheckFn: async () =>
				({
					status: "error",
					findings: [],
					totalDeadLines: 0,
					changedFilesScanned: [],
					message: "knip exploded",
				}) as Awaited<ReturnType<NonNullable<PreGateDeps["runDeadCodeCheckFn"]>>>,
		});
		const result = await runDeadCodeGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
	});
});

// ── runOsvGate ─────────────────────────────────────────────────────

describe("runOsvGate (Issue #1407 split)", () => {
	it("blocking only when vulnGateBlocking && critical > 0", async () => {
		const deps = makeDeps({
			runVulnScanFn: async () =>
				VULNS_FOUND as Awaited<ReturnType<NonNullable<PreGateDeps["runVulnScanFn"]>>>,
		});
		const blocking = await runOsvGate(deps, makeConfig({ vulnGateBlocking: true }), "/wt");
		assert.ok(blocking.failureText?.startsWith("--- OSV Vulnerability Gate ---\n"));
		assert.ok(blocking.failureText?.includes("1 vulnerability(ies) found"));

		const nonBlocking = await runOsvGate(deps, makeConfig({ vulnGateBlocking: false }), "/wt");
		assert.equal(nonBlocking.failureText, null);
	});

	it("vulns without critical (blocking on) → null", async () => {
		const deps = makeDeps({
			runVulnScanFn: async () =>
				({
					...VULNS_FOUND,
					counts: { critical: 0, high: 2, medium: 0, low: 0, unknown: 0 },
				}) as Awaited<ReturnType<NonNullable<PreGateDeps["runVulnScanFn"]>>>,
		});
		const result = await runOsvGate(deps, makeConfig({ vulnGateBlocking: true }), "/wt");
		assert.equal(result.failureText, null);
	});

	it("clean scan → null", async () => {
		const deps = makeDeps({
			runVulnScanFn: async () =>
				CLEAN_OSV as Awaited<ReturnType<NonNullable<PreGateDeps["runVulnScanFn"]>>>,
		});
		const result = await runOsvGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
	});
});

// ── runPackageSafetyGate ───────────────────────────────────────────

describe("runPackageSafetyGate (Issue #1407 split)", () => {
	it("blocked → failureText null, result surfaced, warning notified", async () => {
		const notifyCalls: Array<[string, string]> = [];
		const deps = makeDeps({
			ui: {
				notify: (msg: string, level: string) => notifyCalls.push([msg, level]),
			} as unknown as ExtensionCommandContext["ui"],
			runPackageSafetyAuditFn: async () =>
				({
					status: "blocked",
					results: [
						{
							packageName: "ancient-dep",
							ageDays: 3,
							safe: false,
							blocked: true,
							message: "younger than 14 days",
						},
					],
				}) as Awaited<ReturnType<NonNullable<PreGateDeps["runPackageSafetyAuditFn"]>>>,
		});
		const result = await runPackageSafetyGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
		assert.equal(result.safetyResult?.status, "blocked");
		assert.equal(notifyCalls[0]![1], "warning");
	});

	it("throwing runner → caught, null, no propagate", async () => {
		const deps = makeDeps({
			runPackageSafetyAuditFn: async () => {
				throw new Error("boom");
			},
		});
		const result = await runPackageSafetyGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
		assert.equal(result.safetyResult, undefined);
	});
});

// ── runTraceabilityGate ────────────────────────────────────────────

describe("runTraceabilityGate (Issue #1407 split)", () => {
	it("non-blocking: failureText always null, gaps notified as info", async () => {
		const notifyCalls: Array<[string, string]> = [];
		const deps = makeDeps({
			ui: {
				notify: (msg: string, level: string) => notifyCalls.push([msg, level]),
			} as unknown as ExtensionCommandContext["ui"],
			runRequirementsTraceabilityFn: async () =>
				[
					{ check: "checklist-keyword-coverage", severity: "warning", detail: "missing task" },
				] as Awaited<ReturnType<NonNullable<PreGateDeps["runRequirementsTraceabilityFn"]>>>,
		});
		const result = await runTraceabilityGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
		assert.equal(notifyCalls.length, 1);
		assert.equal(notifyCalls[0]![1], "info");
	});

	it("no gaps → null, silent", async () => {
		const deps = makeDeps({
			runRequirementsTraceabilityFn: async () =>
				[] as Awaited<ReturnType<NonNullable<PreGateDeps["runRequirementsTraceabilityFn"]>>>,
		});
		const result = await runTraceabilityGate(deps, makeConfig(), "/wt");
		assert.equal(result.failureText, null);
	});
});
