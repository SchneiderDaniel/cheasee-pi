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
	parseKnipOutput,
	filterFindingsToChangedFiles,
	buildResult,
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
