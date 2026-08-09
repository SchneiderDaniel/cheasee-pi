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
	filterClonesToChangedFiles,
	mapJscpdType,
	sumDuplicateLines,
	buildResult,
	runDuplicateCheck,
} from "../checks/duplicate-code.ts";
import type { ExecFn } from "../checks/shared.ts";

// ═══════════════════════════════════════════════════════════════════════
// Helper: build a JscpdClone for use in tests
// ═══════════════════════════════════════════════════════════════════════

function makeClone(
	override: Partial<JscpdClone> & {
		files?: Array<{ name: string; startLine: number; endLine: number }>;
	},
): JscpdClone {
	const files = override.files || [{ name: "src/a.ts", startLine: 1, endLine: 10 }];
	return {
		id: override.id || "clone-1",
		format: "typescript",
		lines: override.lines ?? 10,
		tokens: override.tokens ?? 50,
		type: override.type ?? 1,
		fragments: files.map((f) => ({
			fragment: "code fragment",
			file: f.name,
			start: f.startLine,
			end: f.endLine,
		})),
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Domain: Interface shape
// ═══════════════════════════════════════════════════════════════════════

describe("DuplicateCodeResult interface", () => {
	it("status field accepts all 4 literal string values", () => {
		const clean: DuplicateCodeResult = {
			status: "clean",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: [],
		};
		const found: DuplicateCodeResult = {
			status: "duplicates_found",
			clones: [],
			totalDuplicateLines: 10,
			changedFilesScanned: [],
		};
		const error: DuplicateCodeResult = {
			status: "error",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: [],
		};
		const noJscpd: DuplicateCodeResult = {
			status: "no_jscpd",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: [],
		};

		assert.equal(clean.status, "clean");
		assert.equal(found.status, "duplicates_found");
		assert.equal(error.status, "error");
		assert.equal(noJscpd.status, "no_jscpd");
	});

	it("clones array items have correct shape", () => {
		const result: DuplicateCodeResult = {
			status: "duplicates_found",
			clones: [
				{
					type: "exact",
					lines: 10,
					similarity: 100,
					locations: [
						{ file: "src/a.ts", startLine: 1, endLine: 10 },
						{ file: "src/b.ts", startLine: 20, endLine: 29 },
					],
				},
			],
			totalDuplicateLines: 20,
			changedFilesScanned: ["src/a.ts"],
		};

		assert.equal(result.clones.length, 1);
		assert.equal(result.clones[0]!.type, "exact");
		assert.equal(result.clones[0]!.lines, 10);
		assert.equal(result.clones[0]!.similarity, 100);
		assert.equal(result.clones[0]!.locations.length, 2);
		assert.equal(result.clones[0]!.locations[0]!.file, "src/a.ts");
		assert.equal(result.clones[0]!.locations[0]!.startLine, 1);
		assert.equal(result.clones[0]!.locations[0]!.endLine, 10);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: filterClonesToChangedFiles
// ═══════════════════════════════════════════════════════════════════════

describe("filterClonesToChangedFiles()", () => {
	it("keeps clone with location in changed files", () => {
		const clones = [
			makeClone({
				files: [
					{ name: "src/a.ts", startLine: 1, endLine: 10 },
					{ name: "src/c.ts", startLine: 20, endLine: 29 },
				],
			}),
		];
		const filtered = filterClonesToChangedFiles(clones, ["src/a.ts"]);
		assert.equal(filtered.length, 1);
		assert.equal(filtered[0]!.locations[0]!.file, "src/a.ts");
	});

	it("drops clone with no location in changed files", () => {
		const clones = [
			makeClone({
				files: [
					{ name: "src/a.ts", startLine: 1, endLine: 10 },
					{ name: "src/b.ts", startLine: 20, endLine: 29 },
				],
			}),
		];
		const filtered = filterClonesToChangedFiles(clones, ["src/c.ts"]);
		assert.equal(filtered.length, 0);
	});

	it("keeps clone when at least one location is in changed files (one in, one out)", () => {
		const clones = [
			makeClone({
				files: [
					{ name: "src/a.ts", startLine: 1, endLine: 10 },
					{ name: "src/b.ts", startLine: 20, endLine: 29 },
				],
			}),
		];
		const filtered = filterClonesToChangedFiles(clones, ["src/b.ts"]);
		assert.equal(filtered.length, 1);
	});

	it("returns empty array when no clones provided", () => {
		const filtered = filterClonesToChangedFiles([], ["src/a.ts"]);
		assert.equal(filtered.length, 0);
	});

	it("returns empty array when changed files list is empty", () => {
		const clones = [
			makeClone({
				files: [{ name: "src/a.ts", startLine: 1, endLine: 10 }],
			}),
		];
		const filtered = filterClonesToChangedFiles(clones, []);
		assert.equal(filtered.length, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: mapJscpdType
// ═══════════════════════════════════════════════════════════════════════

describe("mapJscpdType()", () => {
	it("maps type 1 to 'exact'", () => {
		assert.equal(mapJscpdType(1), "exact");
	});

	it("maps type 2 to 'renamed'", () => {
		assert.equal(mapJscpdType(2), "renamed");
	});

	it("maps type 3 to 'near-miss'", () => {
		assert.equal(mapJscpdType(3), "near-miss");
	});

	it("maps any other number to 'near-miss' (graceful fallback)", () => {
		assert.equal(mapJscpdType(0), "near-miss");
		assert.equal(mapJscpdType(4), "near-miss");
		assert.equal(mapJscpdType(-1), "near-miss");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: sumDuplicateLines
// ═══════════════════════════════════════════════════════════════════════

describe("sumDuplicateLines()", () => {
	it("sums endLine - startLine + 1 across all clone locations", () => {
		const clones: DuplicateCodeResult["clones"] = [
			{
				type: "exact",
				lines: 10,
				similarity: 100,
				locations: [
					{ file: "a.ts", startLine: 1, endLine: 10 },
					{ file: "b.ts", startLine: 20, endLine: 29 },
					{ file: "c.ts", startLine: 5, endLine: 14 },
				],
			},
			{
				type: "renamed",
				lines: 5,
				similarity: 90,
				locations: [{ file: "d.ts", startLine: 1, endLine: 5 }],
			},
		];
		// Clone 1: (10-1+1) + (29-20+1) + (14-5+1) = 10 + 10 + 10 = 30
		// Clone 2: (5-1+1) = 5
		// Total: 35
		assert.equal(sumDuplicateLines(clones), 35);
	});

	it("returns 0 for empty clones array", () => {
		assert.equal(sumDuplicateLines([]), 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: buildResult
// ═══════════════════════════════════════════════════════════════════════

describe("buildResult()", () => {
	it("builds 'clean' result when no clones pass filter", () => {
		const result = buildResult([], ["src/a.ts"]);
		assert.equal(result.status, "clean");
		assert.equal(result.clones.length, 0);
		assert.equal(result.totalDuplicateLines, 0);
		assert.deepEqual(result.changedFilesScanned, ["src/a.ts"]);
	});

	it("builds 'duplicates_found' result when clone passes filter", () => {
		const clones = [
			makeClone({
				files: [
					{ name: "src/a.ts", startLine: 1, endLine: 10 },
					{ name: "src/b.ts", startLine: 20, endLine: 29 },
				],
			}),
		];
		// Use filterClonesToChangedFiles to get normalized clones
		const filtered = filterClonesToChangedFiles(clones, ["src/a.ts"]);
		const result = buildResult(filtered, ["src/a.ts"]);
		assert.equal(result.status, "duplicates_found");
		assert.equal(result.clones.length, 1);
		assert.equal(result.clones[0]!.type, "exact");
		assert.equal(result.clones[0]!.lines, 10);
		assert.equal(result.clones[0]!.similarity, 100);
		assert.ok(result.totalDuplicateLines > 0);
		assert.deepEqual(result.changedFilesScanned, ["src/a.ts"]);
	});
});

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
