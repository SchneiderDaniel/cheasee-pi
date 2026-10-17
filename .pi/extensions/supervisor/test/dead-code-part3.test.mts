/**
 * Tests for checks/dead-code.ts — pre-audit dead code detection gate
 *
 * Pure function tests for DeadCodeResult/DeadCodeFinding interfaces,
 * knip output parsing, filtering logic, and runDeadCodeCheck orchestration.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	type DeadCodeResult,
	type DeadCodeFinding,
	type KnipIssue,
	type KnipOutput,
	runDeadCodeCheck,
} from "../checks/dead-code.ts";
import type { ExecFn } from "../checks/shared.ts";

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

// ═══════════════════════════════════════════════════════════════════════
// Domain: DeadCodeResult interface shape
// ═══════════════════════════════════════════════════════════════════════

// Split from dead-code.test.mts (issue #2035 Long File refactor).
describe("runDeadCodeCheck()", () => {
	it("calls git diff then knip with correct args", async () => {
		const calls: ExecCall[] = [];
		const mockExec = createMockExec(
			[
				{ code: 0, stdout: "src/a.ts\nsrc/b.ts", stderr: "" },
				{
					code: 1,
					stdout: JSON.stringify({
						files: [],
						issues: [
							{
								file: "src/a.ts",
								line: 10,
								col: 1,
								symbol: "unusedFunc",
								symbolType: "function",
								message: "Function is declared but never used",
							},
						],
					}),
					stderr: "",
				},
			],
			calls,
		);

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");

		// Verify git diff call
		const gitDiffCall = calls.find((c) => c.cmd === "git" && c.args.includes("diff"));
		assert.ok(gitDiffCall, "should call git diff");
		assert.ok(gitDiffCall!.args.includes("main"), "should diff against default branch");
		assert.ok(gitDiffCall!.args.includes("--name-only"), "should use --name-only");
		assert.equal(gitDiffCall!.opts?.cwd, "/repo/worktree");

		// Verify knip call
		const knipCall = calls.find((c) => c.cmd === "npx" && c.args.includes("knip"));
		assert.ok(knipCall, "should call npx knip");
		assert.ok(knipCall!.args.includes("--reporter"), "should include --reporter");
		assert.ok(knipCall!.args.includes("json"), "should set reporter to json");
		assert.ok(knipCall!.args.includes("--include-entry-exports"), "should include entry exports");

		assert.equal(result.status, "dead_found");
		assert.equal(result.changedFilesScanned.length, 2);
		assert.deepEqual(result.changedFilesScanned, ["src/a.ts", "src/b.ts"]);
		assert.equal(result.findings.length, 1);
	});

	it("returns clean when git diff returns empty string (no changed files)", async () => {
		const mockExec = createMockExec([{ code: 0, stdout: "", stderr: "" }]);

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "clean");
		assert.deepEqual(result.changedFilesScanned, []);
		assert.equal(result.findings.length, 0);
	});

	it("returns clean when knip output has no issues", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/a.ts\nsrc/b.ts", stderr: "" },
			{
				code: 0,
				stdout: JSON.stringify({ files: [], issues: [] }),
				stderr: "",
			},
		]);

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "clean");
		assert.equal(result.findings.length, 0);
		assert.equal(result.totalDeadLines, 0);
	});

	it("returns no_knip when knip not found (ENOENT)", async () => {
		const enoent = new Error("spawn npx ENOENT") as Error & { code?: string };
		enoent.code = "ENOENT";

		const calls: ExecCall[] = [];
		const mockExec: ExecFn = async (cmd: string) => {
			calls.push({ cmd, args: [], opts: {} });
			if (cmd === "npx") throw enoent;
			return { code: 0, stdout: "src/a.ts\nsrc/b.ts", stderr: "" };
		};

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "no_knip");
		assert.equal(result.findings.length, 0);
	});

	it("returns error when git diff fails (non-zero exit)", async () => {
		const mockExec = createMockExec([
			{ code: 1, stdout: "", stderr: "fatal: not a git repository" },
		]);

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "error");
		assert.equal(result.findings.length, 0);
	});

	it("returns error when git diff throws non-ENOENT error", async () => {
		const calls: ExecCall[] = [];
		const mockExec: ExecFn = async (cmd: string) => {
			calls.push({ cmd, args: [], opts: {} });
			if (cmd === "git") throw new Error("network error");
			return { code: 0, stdout: "", stderr: "" };
		};

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "error");
	});

	it("returns error when knip exits non-zero without usable JSON output", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/a.ts", stderr: "" },
			{ code: 2, stdout: "", stderr: "knip: internal error" },
		]);

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "error");
	});

	it("returns dead_found when knip finds unused exports in changed files", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/a.ts", stderr: "" },
			{
				code: 1,
				stdout: JSON.stringify({
					files: [],
					issues: [
						{
							file: "src/a.ts",
							line: 10,
							symbol: "unusedFunc",
							symbolType: "function",
						},
					],
				}),
				stderr: "",
			},
		]);

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "dead_found");
		assert.equal(result.findings.length, 1);
		assert.equal(result.findings[0]!.file, "src/a.ts");
		assert.equal(result.findings[0]!.line, 10);
		assert.equal(result.findings[0]!.type, "unused-export");
	});

	it("filters knip findings to only those in changed files", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/a.ts", stderr: "" },
			{
				code: 1,
				stdout: JSON.stringify({
					files: [],
					issues: [
						{
							file: "src/a.ts",
							line: 10,
							symbol: "inChanged",
							symbolType: "function",
						},
						{
							file: "src/b.ts",
							line: 20,
							symbol: "notInChanged",
							symbolType: "function",
						},
					],
				}),
				stderr: "",
			},
		]);

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "dead_found");
		assert.equal(result.findings.length, 1);
		assert.equal(result.findings[0]!.file, "src/a.ts");
		assert.equal(result.findings[0]!.symbol, "inChanged");
	});

	it("returns clean when knip findings are ONLY in unchanged files (filtered out)", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/a.ts", stderr: "" },
			{
				code: 1,
				stdout: JSON.stringify({
					files: [],
					issues: [
						{
							file: "src/c.ts",
							line: 10,
							symbol: "onlyInUnchanged",
							symbolType: "function",
						},
					],
				}),
				stderr: "",
			},
		]);

		const result = await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "clean");
		assert.equal(result.findings.length, 0);
	});

	it("uses provided defaultBranch, not hardcoded", async () => {
		const calls: ExecCall[] = [];
		const mockExec = createMockExec(
			[
				{ code: 0, stdout: "src/x.ts", stderr: "" },
				{
					code: 0,
					stdout: JSON.stringify({ files: [], issues: [] }),
					stderr: "",
				},
			],
			calls,
		);

		await runDeadCodeCheck(mockExec, "/repo/worktree", "develop");
		const gitDiffCall = calls.find((c) => c.cmd === "git" && c.args.includes("diff"));
		assert.ok(gitDiffCall!.args.includes("develop"), "should use provided branch");
	});

	it("runs knip with correct flags: --reporter json, --include-entry-exports, --directory", async () => {
		const calls: ExecCall[] = [];
		const mockExec = createMockExec(
			[
				{ code: 0, stdout: "src/a.ts", stderr: "" },
				{
					code: 0,
					stdout: JSON.stringify({ files: [], issues: [] }),
					stderr: "",
				},
			],
			calls,
		);

		await runDeadCodeCheck(mockExec, "/repo/worktree", "main");
		const knipCall = calls.find((c) => c.cmd === "npx" && c.args.includes("knip"));
		assert.ok(knipCall, "should call npx knip");
		assert.ok(knipCall!.args.includes("--reporter"), "should include --reporter");
		assert.ok(knipCall!.args.includes("json"), "should set reporter to json");
		assert.ok(knipCall!.args.includes("--include-entry-exports"), "should include entry exports");
	});
});
