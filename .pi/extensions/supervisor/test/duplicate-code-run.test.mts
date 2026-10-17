/**
 * Tests for checks/duplicate-code.ts — pre-audit duplicate detection gate
 *
 * Pure function tests for DuplicateCodeResult interface, filter logic,
 * jscpd type mapping, and runDuplicateCheck orchestration.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/duplicate-code.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	type DuplicateCodeResult,
	type JscpdClone,
	type JscpdOutput,
	type NormalizedClone,
	runDuplicateCheck,
} from "../checks/duplicate-code.ts";
import type { ExecFn } from "../checks/shared.ts";

// Split from duplicate-code.test.mts (issue #2035 Long File refactor).
// ═══════════════════════════════════════════════════════════════════════
// Use-case: runDuplicateCheck (with mocked exec)
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
		// Don't advance index for which check — let it always succeed for results
		const r = results[idx] || { code: 0, stdout: "", stderr: "" };
		idx++;
		return Promise.resolve(r);
	};
	(fn as unknown as { calls: ExecCall[] }).calls = callLog;
	return fn;
}

describe("runDuplicateCheck()", () => {
	it("calls git diff then jscpd with correct args", async () => {
		const calls: ExecCall[] = [];
		const mockExec = createMockExec(
			[
				{ code: 0, stdout: "src/a.ts\nsrc/b.ts", stderr: "" },
				{
					code: 0,
					stdout: JSON.stringify({
						statistics: { total: { clones: 1, duplicatedLines: 20, percentage: 5 } },
						duplications: [
							{
								id: "clone-1",
								format: "typescript",
								lines: 10,
								tokens: 50,
								type: 1,
								fragments: [
									{ fragment: "code", file: "src/a.ts", start: 1, end: 10 },
									{ fragment: "code", file: "src/b.ts", start: 20, end: 29 },
								],
							},
						],
					}),
					stderr: "",
				},
			],
			calls,
		);

		const result = await runDuplicateCheck(mockExec, "/repo/worktree", "main");

		// Verify git diff call
		const gitDiffCall = calls.find((c) => c.cmd === "git" && c.args.includes("diff"));
		assert.ok(gitDiffCall, "should call git diff");
		assert.ok(gitDiffCall!.args.includes("main"), "should diff against default branch");
		assert.ok(gitDiffCall!.args.includes("--name-only"), "should use --name-only");
		assert.equal(gitDiffCall!.opts?.cwd, "/repo/worktree");

		// Verify jscpd call
		const jscpdCall = calls.find((c) => c.cmd === "jscpd");
		assert.ok(jscpdCall, "should call jscpd");
		assert.ok(jscpdCall!.args.includes("/repo/worktree"), "should pass worktree path");
		assert.ok(jscpdCall!.args.includes("--min-lines"), "should include --min-lines");
		assert.ok(jscpdCall!.args.includes("5"), "should set min-lines to 5");
		assert.ok(jscpdCall!.args.includes("--min-tokens"), "should include --min-tokens");
		assert.ok(jscpdCall!.args.includes("50"), "should set min-tokens to 50");
		assert.ok(jscpdCall!.args.includes("--output"), "should include --output");
		assert.ok(jscpdCall!.args.includes("json"), "should set output to json");

		assert.equal(result.status, "duplicates_found");
		assert.equal(result.changedFilesScanned.length, 2);
		assert.deepEqual(result.changedFilesScanned, ["src/a.ts", "src/b.ts"]);
	});

	it("returns clean when jscpd output has no duplicates", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/a.ts\nsrc/b.ts", stderr: "" },
			{
				code: 0,
				stdout: JSON.stringify({
					statistics: { total: { clones: 0, duplicatedLines: 0, percentage: 0 } },
					duplications: [],
				}),
				stderr: "",
			},
		]);

		const result = await runDuplicateCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "clean");
		assert.equal(result.clones.length, 0);
		assert.equal(result.totalDuplicateLines, 0);
	});

	it("returns no_jscpd when jscpd not found (ENOENT)", async () => {
		const enoent = new Error("spawn jscpd ENOENT") as Error & { code?: string };
		enoent.code = "ENOENT";

		const calls: ExecCall[] = [];
		const mockExec: ExecFn = async (cmd: string) => {
			calls.push({ cmd, args: [], opts: {} });
			if (cmd === "jscpd") throw enoent;
			return { code: 0, stdout: "src/a.ts\nsrc/b.ts", stderr: "" };
		};

		const result = await runDuplicateCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "no_jscpd");
		assert.equal(result.clones.length, 0);
	});

	it("returns error when jscpd returns non-JSON output", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/a.ts", stderr: "" },
			{ code: 1, stdout: "", stderr: "jscpd: internal error" },
		]);

		const result = await runDuplicateCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "error");
		assert.equal(result.clones.length, 0);
	});

	it("returns error when git diff fails", async () => {
		const mockExec = createMockExec([
			{ code: 1, stdout: "", stderr: "fatal: not a git repository" },
		]);

		const result = await runDuplicateCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "error");
		assert.equal(result.clones.length, 0);
	});

	it("returns clean when git diff returns empty string (no changed files)", async () => {
		const mockExec = createMockExec([{ code: 0, stdout: "", stderr: "" }]);

		const result = await runDuplicateCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "clean");
		assert.deepEqual(result.changedFilesScanned, []);
		assert.equal(result.clones.length, 0);
	});

	it("jscpd returns {} (empty JSON with no duplications key) — returns clean", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/a.ts", stderr: "" },
			{ code: 0, stdout: "{}", stderr: "" },
		]);

		const result = await runDuplicateCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "clean");
		assert.equal(result.clones.length, 0);
	});

	it("uses provided default branch, not hardcoded", async () => {
		const calls: ExecCall[] = [];
		const mockExec = createMockExec(
			[
				{ code: 0, stdout: "src/x.ts", stderr: "" },
				{
					code: 0,
					stdout: JSON.stringify({
						statistics: { total: { clones: 0, duplicatedLines: 0, percentage: 0 } },
						duplications: [],
					}),
					stderr: "",
				},
			],
			calls,
		);

		await runDuplicateCheck(mockExec, "/repo/worktree", "develop");
		const gitDiffCall = calls.find((c) => c.cmd === "git" && c.args.includes("diff"));
		assert.ok(gitDiffCall!.args.includes("develop"), "should use provided branch");
	});

	it("runs jscpd with silent mode (no progress output)", async () => {
		const calls: ExecCall[] = [];
		const mockExec = createMockExec(
			[
				{ code: 0, stdout: "src/a.ts", stderr: "" },
				{
					code: 0,
					stdout: JSON.stringify({
						statistics: { total: { clones: 0, duplicatedLines: 0, percentage: 0 } },
						duplications: [],
					}),
					stderr: "",
				},
			],
			calls,
		);

		await runDuplicateCheck(mockExec, "/repo/worktree", "main");
		const jscpdCall = calls.find((c) => c.cmd === "jscpd");
		assert.ok(jscpdCall!.args.includes("--silent"), "should use --silent to suppress progress");
	});
});
