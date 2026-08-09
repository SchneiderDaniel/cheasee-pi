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
	sumDeadLines,
	buildDeadCodeContext,
	mapKnipFindingType,
	parseKnipOutput,
	filterFindingsToChangedFiles,
	buildResult,
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

describe("DeadCodeResult interface", () => {
	it("status field accepts all 4 literal string values", () => {
		const clean: DeadCodeResult = {
			status: "clean",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: [],
		};
		const found: DeadCodeResult = {
			status: "dead_found",
			findings: [],
			totalDeadLines: 5,
			changedFilesScanned: [],
		};
		const error: DeadCodeResult = {
			status: "error",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: [],
		};
		const noKnip: DeadCodeResult = {
			status: "no_knip",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: [],
		};

		assert.equal(clean.status, "clean");
		assert.equal(found.status, "dead_found");
		assert.equal(error.status, "error");
		assert.equal(noKnip.status, "no_knip");
	});

	it("findings array items have correct shape", () => {
		const result: DeadCodeResult = {
			status: "dead_found",
			findings: [
				{
					file: "src/a.ts",
					line: 10,
					column: 1,
					type: "unused-export",
					symbol: "myFunction",
					confidence: "100%",
					snippet: "export function myFunction() {}",
				},
			],
			totalDeadLines: 1,
			changedFilesScanned: ["src/a.ts"],
		};

		assert.equal(result.findings.length, 1);
		assert.equal(result.findings[0]!.file, "src/a.ts");
		assert.equal(result.findings[0]!.line, 10);
		assert.equal(result.findings[0]!.column, 1);
		assert.equal(result.findings[0]!.type, "unused-export");
		assert.equal(result.findings[0]!.symbol, "myFunction");
		assert.equal(result.findings[0]!.confidence, "100%");
		assert.equal(result.findings[0]!.snippet, "export function myFunction() {}");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: DeadCodeFinding type literal values
// ═══════════════════════════════════════════════════════════════════════

describe("DeadCodeFinding type", () => {
	it("accepts all 7 literal type values", () => {
		const types: DeadCodeFinding["type"][] = [
			"unused-export",
			"unreachable-code",
			"dead-branch",
			"orphaned-import",
			"unused-parameter",
			"empty-block",
			"zombie-dependency",
		];
		for (const t of types) {
			const finding: DeadCodeFinding = {
				file: "a.ts",
				line: 1,
				type: t,
				confidence: "100%",
			};
			assert.equal(finding.type, t);
		}
	});

	it("accepts all 3 confidence values", () => {
		const confidences: DeadCodeFinding["confidence"][] = ["100%", "90%", "60%"];
		for (const c of confidences) {
			const finding: DeadCodeFinding = {
				file: "a.ts",
				line: 1,
				type: "unused-export",
				confidence: c,
			};
			assert.equal(finding.confidence, c);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: sumDeadLines
// ═══════════════════════════════════════════════════════════════════════

describe("sumDeadLines()", () => {
	it("sums finding.line counts across all findings — each contributes 1", () => {
		const findings: DeadCodeFinding[] = [
			{ file: "a.ts", line: 10, type: "unused-export", confidence: "100%" },
			{ file: "a.ts", line: 20, type: "unreachable-code", confidence: "90%" },
			{ file: "b.ts", line: 30, type: "dead-branch", confidence: "60%" },
		];
		assert.equal(sumDeadLines(findings), 3);
	});

	it("returns 0 for empty array", () => {
		assert.equal(sumDeadLines([]), 0);
	});

	it("sums correctly with mixed findings — some with line=0, some positive", () => {
		const findings: DeadCodeFinding[] = [
			{ file: "a.ts", line: 0, type: "dead-branch", confidence: "60%" },
			{ file: "b.ts", line: 5, type: "unused-export", confidence: "100%" },
			{ file: "c.ts", line: 10, type: "orphaned-import", confidence: "90%" },
		];
		assert.equal(sumDeadLines(findings), 3);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: buildDeadCodeContext
// ═══════════════════════════════════════════════════════════════════════

describe("buildDeadCodeContext()", () => {
	it("returns null for null input", () => {
		assert.equal(buildDeadCodeContext(null), null);
	});

	it("returns null for 'clean' status", () => {
		const result: DeadCodeResult = {
			status: "clean",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: [],
		};
		assert.equal(buildDeadCodeContext(result), null);
	});

	it("returns null for 'error' status", () => {
		const result: DeadCodeResult = {
			status: "error",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: [],
			message: "something broke",
		};
		assert.equal(buildDeadCodeContext(result), null);
	});

	it("returns null for 'no_knip' status", () => {
		const result: DeadCodeResult = {
			status: "no_knip",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: [],
		};
		assert.equal(buildDeadCodeContext(result), null);
	});

	it("returns formatted string with heading and findings for 'dead_found' status", () => {
		const result: DeadCodeResult = {
			status: "dead_found",
			findings: [
				{
					file: "src/a.ts",
					line: 10,
					column: 1,
					type: "unused-export",
					symbol: "unusedFunc",
					confidence: "100%",
					snippet: "export function unusedFunc() {}",
				},
			],
			totalDeadLines: 1,
			changedFilesScanned: ["src/a.ts"],
		};
		const ctx = buildDeadCodeContext(result);
		assert.ok(ctx, "should return non-null string");
		assert.ok(ctx!.includes("**1 dead code finding(s) found (1 total lines)**"), ctx);
		assert.ok(ctx!.includes("`src/a.ts`"));
		assert.ok(ctx!.includes("line 10"));
		assert.ok(ctx!.includes("unused-export"));
		assert.ok(ctx!.includes("unusedFunc"));
		assert.ok(ctx!.includes("100%"));
	});

	it("handles findings with optional fields undefined gracefully — no 'undefined' string", () => {
		const result: DeadCodeResult = {
			status: "dead_found",
			findings: [
				{
					file: "src/a.ts",
					line: 5,
					type: "dead-branch",
					confidence: "60%",
				},
			],
			totalDeadLines: 1,
			changedFilesScanned: ["src/a.ts"],
		};
		const ctx = buildDeadCodeContext(result);
		assert.ok(ctx, "should return non-null string");
		assert.ok(!ctx!.includes("undefined"), "output should not contain literal 'undefined'");
	});

	it("returns null for 'dead_found' with empty findings array (edge case)", () => {
		const result: DeadCodeResult = {
			status: "dead_found",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: ["src/a.ts"],
		};
		assert.equal(buildDeadCodeContext(result), null);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: mapKnipFindingType
// ═══════════════════════════════════════════════════════════════════════

describe("mapKnipFindingType()", () => {
	it("maps 'export' to 'unused-export'", () => {
		assert.equal(mapKnipFindingType("export"), "unused-export");
	});

	it("maps 'variable' to 'unused-export'", () => {
		assert.equal(mapKnipFindingType("variable"), "unused-export");
	});

	it("maps 'type' to 'unused-export'", () => {
		assert.equal(mapKnipFindingType("type"), "unused-export");
	});

	it("maps 'function' to 'unused-export'", () => {
		assert.equal(mapKnipFindingType("function"), "unused-export");
	});

	it("maps 'parameter' to 'unused-parameter'", () => {
		assert.equal(mapKnipFindingType("parameter"), "unused-parameter");
	});

	it("maps 'import' to 'orphaned-import'", () => {
		assert.equal(mapKnipFindingType("import"), "orphaned-import");
	});

	it("maps unknown type to 'unused-export' (graceful default)", () => {
		assert.equal(mapKnipFindingType("unknown_type"), "unused-export");
		assert.equal(mapKnipFindingType(""), "unused-export");
		assert.equal(mapKnipFindingType("class"), "unused-export");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: parseKnipOutput
// ═══════════════════════════════════════════════════════════════════════

describe("parseKnipOutput()", () => {
	it("parses valid knip JSON stdout into structured findings", () => {
		const stdout = JSON.stringify({
			files: ["unused-file.ts"],
			issues: [
				{
					file: "src/a.ts",
					line: 10,
					col: 1,
					symbol: "unusedFunc",
					symbolType: "function",
					message: "Function 'unusedFunc' is declared but never used",
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result, "should parse successfully");
		assert.equal(result!.length, 2, "should have 2 findings: 1 unused file + 1 issue");
	});

	it("returns null for empty string", () => {
		assert.equal(parseKnipOutput(""), null);
	});

	it("returns null for non-JSON string", () => {
		assert.equal(parseKnipOutput("not json"), null);
	});

	it("handles empty knip output (no issues, no files)", () => {
		const stdout = JSON.stringify({ files: [], issues: [] });
		const result = parseKnipOutput(stdout);
		assert.ok(result, "should parse empty output");
		assert.equal(result!.length, 0);
	});

	it("handles knip output with files only (no issues)", () => {
		const stdout = JSON.stringify({
			files: ["unused.ts"],
			issues: [],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		assert.equal(result!.length, 1);
		assert.equal(result![0]!.file, "unused.ts");
		assert.equal(result![0]!.type, "dead-branch");
		assert.equal(result![0]!.confidence, "60%");
	});

	it("handles knip output with issues only (no files)", () => {
		const stdout = JSON.stringify({
			files: [],
			issues: [
				{
					file: "src/a.ts",
					line: 5,
					col: 1,
					symbol: "myVar",
					symbolType: "variable",
					message: "Variable 'myVar' is declared but never used",
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		assert.equal(result!.length, 1);
		assert.equal(result![0]!.file, "src/a.ts");
		assert.equal(result![0]!.line, 5);
		assert.equal(result![0]!.symbol, "myVar");
	});

	it("maps parameter symbolType correctly", () => {
		const stdout = JSON.stringify({
			files: [],
			issues: [
				{
					file: "src/a.ts",
					line: 10,
					symbol: "unusedParam",
					symbolType: "parameter",
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		assert.equal(result![0]!.type, "unused-parameter");
	});

	it("handles issues with missing optional fields", () => {
		const stdout = JSON.stringify({
			files: [],
			issues: [
				{
					file: "src/a.ts",
					line: 10,
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		assert.equal(result!.length, 1);
		assert.equal(result![0]!.file, "src/a.ts");
		assert.equal(result![0]!.line, 10);
	});

	// ── Knip v6+ nested format ──

	it("parses knip v6+ nested exports", () => {
		const stdout = JSON.stringify({
			issues: [
				{
					file: "src/a.ts",
					exports: [{ name: "unusedFunc", line: 10, col: 14 }],
					types: [],
					dependencies: [],
					devDependencies: [],
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result, "should parse v6+ format");
		assert.equal(result!.length, 1);
		assert.equal(result![0]!.file, "src/a.ts");
		assert.equal(result![0]!.line, 10);
		assert.equal(result![0]!.column, 14);
		assert.equal(result![0]!.type, "unused-export");
		assert.equal(result![0]!.symbol, "unusedFunc");
		assert.equal(result![0]!.confidence, "100%");
	});

	it("parses knip v6+ nested types", () => {
		const stdout = JSON.stringify({
			issues: [
				{
					file: "src/types.ts",
					exports: [],
					types: [{ name: "UnusedType", line: 15, col: 10 }],
					dependencies: [],
					devDependencies: [],
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		assert.equal(result!.length, 1);
		assert.equal(result![0]!.symbol, "UnusedType");
		assert.equal(result![0]!.type, "unused-export");
	});

	it("parses knip v6+ nested dependencies as zombie-dependency", () => {
		const stdout = JSON.stringify({
			issues: [
				{
					file: "package.json",
					exports: [],
					types: [],
					dependencies: [{ name: "boxen", line: 24, col: 4 }],
					devDependencies: [],
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		assert.equal(result!.length, 1);
		assert.equal(result![0]!.symbol, "boxen");
		assert.equal(result![0]!.type, "zombie-dependency");
		assert.equal(result![0]!.line, 24);
	});

	it("parses knip v6+ nested devDependencies as zombie-dependency", () => {
		const stdout = JSON.stringify({
			issues: [
				{
					file: "package.json",
					exports: [],
					types: [],
					dependencies: [],
					devDependencies: [{ name: "prettier", line: 18, col: 4 }],
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		assert.equal(result!.length, 1);
		assert.equal(result![0]!.symbol, "prettier");
		assert.equal(result![0]!.type, "zombie-dependency");
	});

	it("handles mixed exports, types, deps — all in same file", () => {
		const stdout = JSON.stringify({
			issues: [
				{
					file: "src/all.ts",
					exports: [{ name: "fn1", line: 5, col: 14 }],
					types: [{ name: "T1", line: 10, col: 10 }],
					dependencies: [],
					devDependencies: [],
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		assert.equal(result!.length, 2);
	});

	it("prefers nested format over flat when both present", () => {
		// If nested arrays exist (even empty), use v6+ parser, not flat
		const stdout = JSON.stringify({
			issues: [
				{
					file: "src/a.ts",
					line: 99, // flat fields present but should be ignored
					col: 1,
					symbol: "ignored",
					symbolType: "function",
					message: "should be ignored",
					exports: [{ name: "realFn", line: 10, col: 14 }],
					types: [],
					dependencies: [],
					devDependencies: [],
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		// Should use nested parser (exports), not flat fields
		assert.equal(result!.length, 1);
		assert.equal(result![0]!.symbol, "realFn");
		assert.equal(result![0]!.line, 10); // from nested export, not line:99
	});

	it("handles empty nested arrays (exports: []) — no findings from that file", () => {
		const stdout = JSON.stringify({
			issues: [
				{
					file: "src/clean.ts",
					exports: [],
					types: [],
					dependencies: [],
					devDependencies: [],
				},
			],
		});
		const result = parseKnipOutput(stdout);
		assert.ok(result);
		assert.equal(result!.length, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: filterFindingsToChangedFiles
// ═══════════════════════════════════════════════════════════════════════

describe("filterFindingsToChangedFiles()", () => {
	it("keeps finding whose file is in changed files list", () => {
		const findings: DeadCodeFinding[] = [
			{ file: "src/a.ts", line: 10, type: "unused-export", confidence: "100%" },
		];
		const filtered = filterFindingsToChangedFiles(findings, ["src/a.ts"]);
		assert.equal(filtered.length, 1);
		assert.equal(filtered[0]!.file, "src/a.ts");
	});

	it("drops finding whose file is not in changed files list", () => {
		const findings: DeadCodeFinding[] = [
			{ file: "src/b.ts", line: 10, type: "unused-export", confidence: "100%" },
		];
		const filtered = filterFindingsToChangedFiles(findings, ["src/a.ts"]);
		assert.equal(filtered.length, 0);
	});

	it("keeps some and drops others when mixed", () => {
		const findings: DeadCodeFinding[] = [
			{ file: "src/a.ts", line: 10, type: "unused-export", confidence: "100%" },
			{ file: "src/b.ts", line: 20, type: "unreachable-code", confidence: "90%" },
			{ file: "src/c.ts", line: 30, type: "dead-branch", confidence: "60%" },
		];
		const filtered = filterFindingsToChangedFiles(findings, ["src/a.ts", "src/c.ts"]);
		assert.equal(filtered.length, 2);
		assert.equal(filtered[0]!.file, "src/a.ts");
		assert.equal(filtered[1]!.file, "src/c.ts");
	});

	it("returns empty array when no findings provided", () => {
		const filtered = filterFindingsToChangedFiles([], ["src/a.ts"]);
		assert.equal(filtered.length, 0);
	});

	it("returns empty array when changed files list is empty", () => {
		const findings: DeadCodeFinding[] = [
			{ file: "src/a.ts", line: 10, type: "unused-export", confidence: "100%" },
		];
		const filtered = filterFindingsToChangedFiles(findings, []);
		assert.equal(filtered.length, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: buildResult
// ═══════════════════════════════════════════════════════════════════════

describe("buildResult()", () => {
	it("builds 'clean' result when no findings pass filter", () => {
		const result = buildResult([], ["src/a.ts"]);
		assert.equal(result.status, "clean");
		assert.equal(result.findings.length, 0);
		assert.equal(result.totalDeadLines, 0);
		assert.deepEqual(result.changedFilesScanned, ["src/a.ts"]);
	});

	it("builds 'dead_found' result when findings pass filter", () => {
		const findings: DeadCodeFinding[] = [
			{ file: "src/a.ts", line: 10, type: "unused-export", confidence: "100%" },
		];
		const result = buildResult(findings, ["src/a.ts"]);
		assert.equal(result.status, "dead_found");
		assert.equal(result.findings.length, 1);
		assert.equal(result.findings[0]!.type, "unused-export");
		assert.ok(result.totalDeadLines > 0);
		assert.deepEqual(result.changedFilesScanned, ["src/a.ts"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Use-case: runDeadCodeCheck (with mocked exec)
// ═══════════════════════════════════════════════════════════════════════

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
