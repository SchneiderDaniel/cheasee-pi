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
