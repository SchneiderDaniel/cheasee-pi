// ─── Tests: package-safety.ts — runPackageSafetyAudit ───────────────
// Integration-level tests with mocked exec function.
// Tests the runPackageSafetyAudit entry point that reads package.json
// and runs npm view checks for each dependency.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPackageSafetyAudit, SAFETY_THRESHOLD_DAYS } from "../checks/package-safety.ts";
import type { PackageSafetyAuditResult } from "../checks/package-safety.ts";

// ─── ExecFn type for mock ──────────────────────────────────────────

type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

// ─── Mock package.json paths ───────────────────────────────────────

const FAKE_WORKTREE = "/tmp/fake-worktree";

// ─── Helpers ───────────────────────────────────────────────────────

function mockExecForPackages(pkgDates: Record<string, string>): ExecFn {
	return async (cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
		if (cmd === "npm") {
			// Find which package the args refer to — last arg is the package name
			const viewArg = _args.find(
				(a) => !a.startsWith("--") && a !== "view" && a !== "time.created",
			);
			const pkgName = viewArg || "";
			const createdDate = pkgDates[pkgName];
			if (createdDate === "__ENOENT__") {
				const err = new Error("spawn npm ENOENT") as Error & { code?: string };
				err.code = "ENOENT";
				throw err;
			}
			if (createdDate === "__FAIL__") {
				return { code: 1, stdout: "", stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found" };
			}
			if (createdDate === "__EMPTY__") {
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: createdDate + "\n", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

/**
 * Create a mock exec that also records calls for verification.
 */
function mockExecWithRecording(
	pkgDates: Record<string, string>,
	calls: Array<{ cmd: string; args: string[] }>,
): ExecFn {
	const fn: ExecFn = async (cmd, args, _opts) => {
		calls.push({ cmd, args });
		if (cmd === "npm") {
			const viewArg = args.find((a) => !a.startsWith("--") && a !== "view" && a !== "time.created");
			const pkgName = viewArg || "";
			const createdDate = pkgDates[pkgName];
			if (createdDate === "__ENOENT__") {
				const err = new Error("spawn npm ENOENT") as Error & { code?: string };
				err.code = "ENOENT";
				throw err;
			}
			if (createdDate === "__FAIL__") {
				return { code: 1, stdout: "", stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found" };
			}
			return { code: 0, stdout: createdDate + "\n", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	return fn;
}

// ─── Tests: runPackageSafetyAudit ──────────────────────────────────

describe("runPackageSafetyAudit", () => {
	// ─── No package.json ──────────────────────────────────────────

	it("returns safe with empty results when worktree path has no package.json", async () => {
		// Use a non-existent path
		const result = await runPackageSafetyAudit(mockExecForPackages({}), "/nonexistent/path/12345");
		assert.equal(result.status, "safe");
		assert.equal(result.results.length, 0);
	});

	// ─── Package.json with no deps ────────────────────────────────

	it("returns safe with empty results when package.json has no dependencies", async () => {
		const result = await runPackageSafetyAudit(
			mockExecForPackages({}),
			FAKE_WORKTREE,
			JSON.stringify({
				name: "test-project",
				version: "1.0.0",
			}),
		);
		assert.equal(result.status, "safe");
		assert.equal(result.results.length, 0);
	});

	it("returns safe with empty results when package.json has empty dependencies and devDependencies", async () => {
		const result = await runPackageSafetyAudit(
			mockExecForPackages({}),
			FAKE_WORKTREE,
			JSON.stringify({
				name: "test-project",
				dependencies: {},
				devDependencies: {},
			}),
		);
		assert.equal(result.status, "safe");
		assert.equal(result.results.length, 0);
	});

	// ─── All deps old enough → safe ───────────────────────────────

	it("returns safe when all dependencies are older than threshold", async () => {
		// Create dates 30 days ago
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const dateStr = thirtyDaysAgo.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({
				lodash: dateStr,
				express: dateStr,
			}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					lodash: "^4.17.21",
					express: "^4.18.2",
				},
			}),
		);
		assert.equal(result.status, "safe");
		assert.equal(result.results.length, 2);
		assert.ok(result.results.every((r) => r.safe === true));
	});

	// ─── Young dep → blocked ─────────────────────────────────────

	it("returns blocked when a dependency is younger than threshold", async () => {
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 30);
		const youngDate = new Date();
		youngDate.setDate(youngDate.getDate() - 3);
		const youngDateStr = youngDate.toISOString();
		const oldDateStr = oldDate.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({
				lodash: oldDateStr,
				"evil-package": youngDateStr,
			}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					lodash: "^4.17.21",
					"evil-package": "^1.0.0",
				},
			}),
		);
		assert.equal(result.status, "blocked");
		const evilResult = result.results.find((r) => r.packageName === "evil-package");
		assert.ok(evilResult, "should have result for evil-package");
		assert.equal(evilResult!.safe, false);
		assert.equal(evilResult!.blocked, true);
		assert.ok(evilResult!.ageDays < SAFETY_THRESHOLD_DAYS);
		assert.ok(evilResult!.message.includes("evil-package"));
		const lodashResult = result.results.find((r) => r.packageName === "lodash");
		assert.ok(lodashResult!.safe, "lodash should still be safe");
	});

	// ─── ENOENT fail-closed ──────────────────────────────────────

	it("returns blocked when npm view fails with ENOENT (fail-closed)", async () => {
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 30);
		const oldDateStr = oldDate.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({
				lodash: oldDateStr,
				"missing-pkg": "__ENOENT__",
			}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					lodash: "^4.17.21",
					"missing-pkg": "^1.0.0",
				},
			}),
		);
		assert.equal(result.status, "blocked");
		const missingResult = result.results.find((r) => r.packageName === "missing-pkg");
		assert.ok(missingResult, "should have result for missing-pkg");
		assert.equal(missingResult!.safe, false);
		assert.equal(missingResult!.blocked, true);
	});

	// ─── Unparseable date fail-closed ────────────────────────────

	it("returns blocked when npm view returns unparseable date (fail-closed)", async () => {
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 30);
		const oldDateStr = oldDate.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({
				lodash: oldDateStr,
				"weird-pkg": "not-a-date-at-all",
			}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					lodash: "^4.17.21",
					"weird-pkg": "^1.0.0",
				},
			}),
		);
		assert.equal(result.status, "blocked");
		const weirdResult = result.results.find((r) => r.packageName === "weird-pkg");
		assert.ok(weirdResult, "should have result for weird-pkg");
		assert.equal(weirdResult!.safe, false);
		assert.equal(weirdResult!.blocked, true);
	});

	// ─── npm view fails with error code ──────────────────────────

	it("returns blocked when npm view returns non-zero exit code (fail-closed)", async () => {
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 30);
		const oldDateStr = oldDate.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({
				lodash: oldDateStr,
				"not-found": "__FAIL__",
			}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					lodash: "^4.17.21",
					"not-found": "^999.0.0",
				},
			}),
		);
		assert.equal(result.status, "blocked");
		const nfResult = result.results.find((r) => r.packageName === "not-found");
		assert.ok(nfResult, "should have result for not-found");
		assert.equal(nfResult!.safe, false);
		assert.equal(nfResult!.blocked, true);
	});

	// ─── Empty stdout ───────────────────────────────────────────

	it("returns blocked when npm view returns empty stdout (fail-closed)", async () => {
		const result = await runPackageSafetyAudit(
			mockExecForPackages({
				"empty-pkg": "__EMPTY__",
			}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					"empty-pkg": "^1.0.0",
				},
			}),
		);
		assert.equal(result.status, "blocked");
		const emptyResult = result.results.find((r) => r.packageName === "empty-pkg");
		assert.ok(emptyResult, "should have result for empty-pkg");
		assert.equal(emptyResult!.safe, false);
		assert.equal(emptyResult!.blocked, true);
	});

	// ─── Exempt packages (git URL, tarball, local path) ──────────

	it("skips age check for git URL dependencies (exempt)", async () => {
		const result = await runPackageSafetyAudit(
			mockExecForPackages({}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					"my-lib": "git+https://github.com/user/repo.git",
				},
			}),
		);
		assert.equal(result.status, "safe");
		assert.equal(result.results.length, 1);
		assert.equal(result.results[0]!.packageName, "my-lib");
		assert.equal(result.results[0]!.safe, true);
		assert.equal(result.results[0]!.blocked, false);
		assert.equal(result.results[0]!.ageDays, 0);
	});

	it("skips age check for tarball URL dependencies (exempt)", async () => {
		const result = await runPackageSafetyAudit(
			mockExecForPackages({}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					"some-tar": "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
				},
			}),
		);
		assert.equal(result.status, "safe");
		assert.equal(result.results[0]!.safe, true);
	});

	it("skips age check for local path dependencies (exempt)", async () => {
		const result = await runPackageSafetyAudit(
			mockExecForPackages({}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					"local-pkg": "../shared-lib",
				},
			}),
		);
		assert.equal(result.status, "safe");
		assert.equal(result.results[0]!.safe, true);
	});

	// ─── Result shape ──────────────────────────────────────────

	it("result items have correct shape: packageName, ageDays, safe, blocked, message", async () => {
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const dateStr = thirtyDaysAgo.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({ "test-pkg": dateStr }),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: { "test-pkg": "^1.0.0" },
			}),
		);
		assert.ok(result.results.length > 0);
		const item = result.results[0]!;
		assert.ok(typeof item.packageName === "string");
		assert.ok(typeof item.ageDays === "number");
		assert.ok(typeof item.safe === "boolean");
		assert.ok(typeof item.blocked === "boolean");
		assert.ok(typeof item.message === "string");
	});

	// ─── Configurable threshold ─────────────────────────────────

	it("uses SAFETY_THRESHOLD_DAYS configurable threshold", async () => {
		// Package published 13 days ago — should be blocked at 14-day threshold
		const thirteenDaysAgo = new Date();
		thirteenDaysAgo.setDate(thirteenDaysAgo.getDate() - 13);
		const dateStr = thirteenDaysAgo.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({ "test-pkg": dateStr }),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: { "test-pkg": "^1.0.0" },
			}),
		);
		assert.equal(result.status, "blocked");
		assert.equal(result.results[0]!.safe, false);
	});

	// ─── Scoped packages ───────────────────────────────────────

	it("handles scoped packages (@scope/name)", async () => {
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const dateStr = thirtyDaysAgo.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({ "@scope/pkg": dateStr }),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: { "@scope/pkg": "^1.0.0" },
			}),
		);
		assert.equal(result.status, "safe");
		assert.equal(result.results.length, 1);
		assert.equal(result.results[0]!.packageName, "@scope/pkg");
	});

	// ─── Scoped package blocked ────────────────────────────────

	it("blocks young scoped packages", async () => {
		const youngDate = new Date();
		youngDate.setDate(youngDate.getDate() - 3);
		const youngDateStr = youngDate.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({ "@scope/young": youngDateStr }),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: { "@scope/young": "^1.0.0" },
			}),
		);
		assert.equal(result.status, "blocked");
		assert.equal(result.results[0]!.safe, false);
		assert.ok(result.results[0]!.message.includes("@scope/young"));
	});

	// ─── devDependencies also checked ──────────────────────────

	it("checks devDependencies in addition to dependencies", async () => {
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const oldDateStr = thirtyDaysAgo.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({
				"prod-pkg": oldDateStr,
				"dev-pkg": oldDateStr,
			}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: { "prod-pkg": "^1.0.0" },
				devDependencies: { "dev-pkg": "^2.0.0" },
			}),
		);
		assert.equal(result.status, "safe");
		assert.equal(result.results.length, 2);
	});

	// ─── Blocked message format ────────────────────────────────

	it("blocked message includes package name, age, and threshold", async () => {
		const youngDate = new Date();
		youngDate.setDate(youngDate.getDate() - 3);
		const youngDateStr = youngDate.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({ "test-pkg": youngDateStr }),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: { "test-pkg": "^1.0.0" },
			}),
		);
		const blocked = result.results.find((r) => !r.safe)!;
		assert.ok(blocked.message.includes("test-pkg"));
		assert.ok(blocked.message.includes(`${blocked.ageDays}`));
		assert.ok(blocked.message.includes(`${SAFETY_THRESHOLD_DAYS}`));
	});

	// ─── Boundary: Empty package.json ──────────────────────────

	it("handles empty package.json ({}) - safe with empty results", async () => {
		const result = await runPackageSafetyAudit(mockExecForPackages({}), FAKE_WORKTREE, "{}");
		assert.equal(result.status, "safe");
		assert.equal(result.results.length, 0);
	});

	// ─── Boundary: Malformed JSON ──────────────────────────────

	it("handles malformed package.json - returns error status", async () => {
		const result = await runPackageSafetyAudit(
			mockExecForPackages({}),
			FAKE_WORKTREE,
			"this is not json",
		);
		assert.equal(result.status, "error");
		assert.ok(result.message);
	});

	// ─── Mix of exempt, safe, and blocked ──────────────────────

	it("handles mix of exempt, safe, and blocked packages correctly", async () => {
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const oldDateStr = thirtyDaysAgo.toISOString();
		const youngDate = new Date();
		youngDate.setDate(youngDate.getDate() - 3);
		const youngDateStr = youngDate.toISOString();

		const result = await runPackageSafetyAudit(
			mockExecForPackages({
				"safe-pkg": oldDateStr,
				"young-pkg": youngDateStr,
			}),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					"safe-pkg": "^1.0.0",
					"young-pkg": "^2.0.0",
					"git-lib": "git+https://github.com/user/repo.git",
					"local-lib": "../local-pkg",
				},
			}),
		);
		assert.equal(result.status, "blocked");
		assert.equal(result.results.length, 4);
		const safe = result.results.find((r) => r.packageName === "safe-pkg")!;
		assert.equal(safe.safe, true);
		const young = result.results.find((r) => r.packageName === "young-pkg")!;
		assert.equal(young.safe, false);
		const git = result.results.find((r) => r.packageName === "git-lib")!;
		assert.equal(git.safe, true);
		const local = result.results.find((r) => r.packageName === "local-lib")!;
		assert.equal(local.safe, true);
	});

	// ─── npm view called with correct args ─────────────────────

	it("calls npm view <pkg> time.created for each dependency", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const dateStr = thirtyDaysAgo.toISOString();

		await runPackageSafetyAudit(
			mockExecWithRecording(
				{
					lodash: dateStr,
					express: dateStr,
				},
				calls,
			),
			FAKE_WORKTREE,
			JSON.stringify({
				dependencies: {
					lodash: "^4.17.21",
					express: "^4.18.2",
				},
			}),
		);

		const npmCalls = calls.filter((c) => c.cmd === "npm");
		assert.equal(npmCalls.length, 2);
		assert.ok(npmCalls.some((c) => c.args.includes("lodash")));
		assert.ok(npmCalls.some((c) => c.args.includes("express")));
		for (const call of npmCalls) {
			assert.ok(call.args.includes("view"));
			assert.ok(call.args.includes("time.created"));
		}
	});
});
