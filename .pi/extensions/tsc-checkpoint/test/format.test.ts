/**
 * Tests for format.ts — All display formatters with known input/output,
 * edge cases (empty, large messages).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/format.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import { formatTrend, formatDiagnostics, formatDiagnosticsJson } from "../format.ts";

import type { TscDiagnostic, DiagnosticTrend } from "../types.ts";

// ═══════════════════════════════════════════════════════════════════════
// formatTrend
// ═══════════════════════════════════════════════════════════════════════

describe("formatTrend", () => {
	it("formats regressed trend with ↑ arrow", () => {
		const result = formatTrend({
			current: 5,
			previous: 2,
			direction: "regressed",
			delta: 3,
		});
		assert.ok(result.includes("5 errors"));
		assert.ok(result.includes("↑"));
		assert.ok(result.includes("3"));
	});

	it("formats improved trend with ↓ arrow", () => {
		const result = formatTrend({
			current: 1,
			previous: 4,
			direction: "improved",
			delta: 3,
		});
		assert.ok(result.includes("1 errors"));
		assert.ok(result.includes("↓"));
	});

	it("formats stable trend with → arrow", () => {
		const result = formatTrend({
			current: 2,
			previous: 2,
			direction: "stable",
			delta: 0,
		});
		assert.ok(result.includes("→"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// formatDiagnostics
// ═══════════════════════════════════════════════════════════════════════

describe("formatDiagnostics", () => {
	it("formats non-empty diagnostics with filePath, line, severity, message, code", () => {
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
		assert.ok(result.includes("/project/src/app.ts"));
		assert.ok(result.includes("Line 10"));
		assert.ok(result.includes("(TS2322)"));
	});

	it("formats with code undefined → no code suffix", () => {
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
		assert.ok(result.includes("No code error"));
		assert.ok(!result.includes("(TS"));
	});

	it("returns empty string for empty array", () => {
		assert.strictEqual(formatDiagnostics([]), "");
	});

	it("formats multiple diagnostics separated by newline", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				code: "TS1000",
				filePath: "/a.ts",
			},
			{
				file: "b.ts",
				line: 2,
				column: 2,
				severity: "Error",
				message: "err2",
				code: "TS2000",
				filePath: "/b.ts",
			},
		];
		const result = formatDiagnostics(diags);
		const lines = result.split("\n");
		assert.strictEqual(lines.length, 2);
		assert.ok(lines[0]!.includes("TS1000"));
		assert.ok(lines[1]!.includes("TS2000"));
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
