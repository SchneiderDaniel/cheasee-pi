import { describe, it } from "node:test";

import assert from "node:assert/strict";

import {
	type OsvFinding,
	type OsvScanResult,
	parseOsvJson,
	buildVulnContext,
	runVulnScan,
} from "../../checks/osv-scanner.ts";

import type { ExecFn } from "../../checks/shared.ts";

import { CLEAN_JSON, VULNS_JSON, CC_COMMIT_MATCH_JSON } from "./osv-scanner-fixtures.mts";

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
			results: [
				{
					source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
					packages: [
						{
							package: { name: "test-pkg", version: "1.0.0", ecosystem: "npm" },
							vulnerabilities: [
								{
									id: "GHSA-uuuu-uuuu-uuuu",
									aliases: [],
									summary: "Unknown severity vuln",
								},
							],
							groups: [{ ids: ["GHSA-uuuu-uuuu-uuuu"] }],
						},
					],
				},
			],
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
describe("runVulnScan()", () => {
	it("exit code 0 with clean JSON returns clean", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec([{ code: 0, stdout: CLEAN_JSON, stderr: "" }], calls);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "clean");
		assert.equal(result.findings.length, 0);
	});

	it("exit code 1 with vulns JSON returns vulns_found", async () => {
		const exec = createMockExec([{ code: 1, stdout: VULNS_JSON, stderr: "" }]);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "vulns_found");
		assert.equal(result.findings.length, 4);
	});

	it("exit code 127 returns error with stderr", async () => {
		const exec = createMockExec([{ code: 127, stdout: "", stderr: "osv-scanner: unknown flag" }]);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "error");
		assert.ok(result.message!.includes("unknown flag"));
	});

	it("exit code 128 returns no_lockfiles", async () => {
		const exec = createMockExec([{ code: 128, stdout: "", stderr: "No lockfiles found" }]);
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
		const exec = createMockExec([{ code: 0, stdout: CLEAN_JSON, stderr: "" }], calls);
		await runVulnScan(exec, "/worktrees/test");
		assert.ok(calls.length >= 1);
		const args = calls[0]!.args;
		assert.ok(args.includes("--recursive"), `expected --recursive in args: ${args}`);
		assert.ok(args.includes("--format"), `expected --format in args: ${args}`);
		assert.ok(args.includes("json"), `expected json in args: ${args}`);
	});

	it("worktree path passed as positional arg", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec([{ code: 0, stdout: CLEAN_JSON, stderr: "" }], calls);
		await runVulnScan(exec, "/my/worktree");
		assert.ok(calls[0]!.args.includes("/my/worktree"));
	});

	it("uses V2 syntax: scan source subcommands", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec([{ code: 0, stdout: CLEAN_JSON, stderr: "" }], calls);
		await runVulnScan(exec, "/worktrees/test");
		const args = calls[0]!.args;
		assert.equal(args[0], "scan");
		assert.equal(args[1], "source");
	});

	it("timeout default is 60s (60000ms)", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec([{ code: 0, stdout: CLEAN_JSON, stderr: "" }], calls);
		await runVulnScan(exec, "/worktrees/test");
		const opts = calls[0]!.opts as Record<string, unknown> | undefined;
		assert.equal(opts?.timeout, 60000);
	});

	it("timeout option from opts is used", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec([{ code: 0, stdout: CLEAN_JSON, stderr: "" }], calls);
		await runVulnScan(exec, "/worktrees/test", { timeoutSec: 30 });
		const opts = calls[0]!.opts as Record<string, unknown> | undefined;
		assert.equal(opts?.timeout, 30000);
	});

	it("configPath option adds --config flag", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec([{ code: 0, stdout: CLEAN_JSON, stderr: "" }], calls);
		await runVulnScan(exec, "/worktrees/test", { configPath: "/worktrees/test/osv-scanner.toml" });
		const args = calls[0]!.args;
		const configIdx = args.indexOf("--config");
		assert.notEqual(configIdx, -1, "expected --config in args");
		assert.equal(args[configIdx + 1], "/worktrees/test/osv-scanner.toml");
	});

	it("exit code 0 with stdout empty returns clean (empty stdout = no findings)", async () => {
		const exec = createMockExec([{ code: 0, stdout: "", stderr: "" }]);
		const result = await runVulnScan(exec, "/worktrees/test");
		assert.equal(result.status, "clean"); // Exit 0 + empty stdout = clean
		assert.equal(result.findings.length, 0);
	});

	it("calls osv-scanner with correct command", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec([{ code: 0, stdout: CLEAN_JSON, stderr: "" }], calls);
		await runVulnScan(exec, "/worktrees/test");
		assert.equal(calls[0]!.cmd, "osv-scanner");
	});
});
