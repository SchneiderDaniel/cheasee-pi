/**
 * Tests for format.ts — All display formatters with known input/output,
 * edge cases (empty, large messages).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/format.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import { formatDiagnostics, formatDiagnosticsJson } from "../format.ts";

import type { TscDiagnostic, DiagnosticTrend } from "../types.ts";

// ═══════════════════════════════════════════════════════════════════════
// formatDiagnostics
// ═══════════════════════════════════════════════════════════════════════

describe("formatDiagnostics", () => {
	it("formats single diagnostic with code", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type error",
				code: "TS2322",
				filePath: "/project/src/app.ts",
			},
		];
		const result = formatDiagnostics(diags);
		assert.strictEqual(result, "src/app.ts, Line 10: [Error] Type error (TS2322)");
	});

	it("formats single diagnostic without code → no code suffix", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "src/app.ts",
				line: 5,
				column: 1,
				severity: "Error",
				message: "No code error",
				filePath: "/project/src/app.ts",
			},
		];
		const result = formatDiagnostics(diags);
		assert.strictEqual(result, "src/app.ts, Line 5: [Error] No code error");
	});

	it("returns empty string for empty array", () => {
		assert.strictEqual(formatDiagnostics([]), "");
	});

	it("returns empty string for null/undefined", () => {
		assert.strictEqual(formatDiagnostics(null as unknown as TscDiagnostic[]), "");
		assert.strictEqual(formatDiagnostics(undefined as unknown as TscDiagnostic[]), "");
	});

	it("truncates message longer than 500 characters", () => {
		const longMsg = "x".repeat(600);
		const diags: TscDiagnostic[] = [
			{
				file: "src/a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: longMsg,
				code: "TS1000",
				filePath: "/project/src/a.ts",
			},
		];
		const result = formatDiagnostics(diags);
		const prefix = "src/a.ts, Line 1: [Error] ";
		const suffix = " (TS1000)";
		// Message part between prefix and code suffix: 497 chars + "..." = 500 chars
		const msgPart = result.slice(prefix.length, -suffix.length);
		assert.strictEqual(msgPart.length, 500, "message part should be 497 truncated chars + '...'");
		assert.ok(msgPart.endsWith("..."), "message should contain truncation ellipsis");
		// Verify the full 600-char message is NOT present
		assert.ok(
			!result.includes("x".repeat(498)),
			"result should not contain the full 600-char string",
		);
	});

	it("groups diagnostics by file, sorts files alphabetically and diagnostics by line/col", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "src/b.ts",
				line: 5,
				column: 10,
				severity: "Error",
				message: "err b1",
				code: "TS1000",
				filePath: "/project/src/b.ts",
			},
			{
				file: "src/a.ts",
				line: 3,
				column: 5,
				severity: "Error",
				message: "err a1",
				code: "TS2000",
				filePath: "/project/src/a.ts",
			},
			{
				file: "src/a.ts",
				line: 1,
				column: 2,
				severity: "Error",
				message: "err a0",
				code: "TS3000",
				filePath: "/project/src/a.ts",
			},
		];
		const result = formatDiagnostics(diags);
		const lines = result.split("\n");

		// a.ts should come first (alphabetically), with line 1 before line 3
		const a0Idx = lines.findIndex((l) => l.includes("err a0"));
		const a1Idx = lines.findIndex((l) => l.includes("err a1"));
		const bIdx = lines.findIndex((l) => l.includes("err b1"));

		assert.ok(a0Idx >= 0, "err a0 should be present");
		assert.ok(a1Idx >= 0, "err a1 should be present");
		assert.ok(bIdx >= 0, "err b1 should be present");

		// a.ts lines should come before b.ts
		assert.ok(a0Idx < bIdx, "a.ts should come before b.ts");
		assert.ok(a1Idx < bIdx, "a.ts second error should come before b.ts");
		// Within a.ts, line 1 should come before line 3
		assert.ok(a0Idx < a1Idx, "line 1 should come before line 3 within a.ts");

		// Blank-line separator between file groups
		const blankIdx = lines.findIndex((l) => l === "");
		assert.ok(blankIdx >= 0, "should have blank-line separator between file groups");
		assert.ok(blankIdx > a1Idx, "blank line should be after a.ts errors");
		assert.ok(blankIdx < bIdx, "blank line should be before b.ts errors");
	});

	it("sorts multiple diagnostics within same file by line then column", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "a.ts",
				line: 3,
				column: 5,
				severity: "Error",
				message: "second",
				filePath: "/abs/a.ts",
			},
			{
				file: "a.ts",
				line: 1,
				column: 10,
				severity: "Error",
				message: "first",
				filePath: "/abs/a.ts",
			},
		];
		const result = formatDiagnostics(diags);
		const lines = result.split("\n");
		assert.ok(lines[0]!.includes("first"), "line 1 should come before line 3");
		assert.ok(lines[1]!.includes("second"), "line 3 should come after line 1");
		// Only two lines, no blank line separator since it's one file
		assert.strictEqual(lines.length, 2);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// formatDiagnosticsJson
// ═══════════════════════════════════════════════════════════════════════

describe("formatDiagnosticsJson", () => {
	it("returns correct structure with diagnostics", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "src/a.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type error",
				code: "TS2322",
				filePath: "/project/src/a.ts",
			},
		];
		const result = formatDiagnosticsJson(diags);
		assert.strictEqual(result.diagnostics.length, 1);
		assert.strictEqual(result.fileCount, 1);
		assert.ok(result.summary.includes("1 type error(s) found"));
	});

	it("empty diagnostics returns empty array, summary 'No type errors detected', fileCount 0", () => {
		const result = formatDiagnosticsJson([]);
		assert.deepStrictEqual(result.diagnostics, []);
		assert.strictEqual(result.summary, "No type errors detected");
		assert.strictEqual(result.fileCount, 0);
	});

	it("summary includes trend direction and delta when trend provided", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "src/a.ts",
				line: 5,
				column: 3,
				severity: "Error",
				message: "err",
				code: "TS2304",
				filePath: "/project/src/a.ts",
			},
			{
				file: "src/b.ts",
				line: 10,
				column: 1,
				severity: "Error",
				message: "err2",
				code: "TS2322",
				filePath: "/project/src/b.ts",
			},
			{
				file: "src/c.ts",
				line: 15,
				column: 7,
				severity: "Error",
				message: "err3",
				code: "TS2554",
				filePath: "/project/src/c.ts",
			},
		];
		const trend: DiagnosticTrend = {
			current: 3,
			previous: 1,
			direction: "regressed",
			delta: 2,
		};
		const result = formatDiagnosticsJson(diags, trend);
		assert.strictEqual(result.diagnostics.length, 3);
		assert.strictEqual(result.fileCount, 3);
		assert.ok(result.summary.includes("3 type error(s) found"));
		assert.ok(result.summary.includes("regressed ↑"));
		assert.ok(result.summary.includes("2"));
		assert.ok(result.summary.includes("was 1"));
	});

	it("fileCount counts unique filePaths", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				code: "TS2322",
				filePath: "/project/src/a.ts",
			},
			{
				file: "a.ts",
				line: 5,
				column: 3,
				severity: "Error",
				message: "err2",
				code: "TS2304",
				filePath: "/project/src/a.ts",
			},
			{
				file: "b.ts",
				line: 10,
				column: 1,
				severity: "Error",
				message: "err3",
				code: "TS2554",
				filePath: "/project/src/b.ts",
			},
		];
		const result = formatDiagnosticsJson(diags);
		assert.strictEqual(result.diagnostics.length, 3);
		assert.strictEqual(result.fileCount, 2); // Two unique files
	});
});
