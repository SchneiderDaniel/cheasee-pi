/**
 * Tests for lib/tsc-types.ts — shared TypeScript type-check types and formatter.
 *
 * formatTscDiagnostics tests migrated from tsc-decisions.test.mts.
 * formatTscDiagnostics itself is defined in .pi/extensions/lib/tsc-types.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/tsc-types.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { formatTscDiagnostics } from "../../lib/tsc-types.ts";

// ═══════════════════════════════════════════════════════════════════════
// formatTscDiagnostics tests
// ═══════════════════════════════════════════════════════════════════════

describe("formatTscDiagnostics", () => {
	it("empty diagnostics → empty string", () => {
		assert.strictEqual(formatTscDiagnostics([]), "");
	});

	it("single diagnostic with code → formatted line", () => {
		const result = formatTscDiagnostics([
			{
				file: "file",
				line: 1,
				column: 1,
				severity: "Error" as const,
				message: "message",
				code: "TS2322",
				filePath: "/abs/file",
			},
		]);
		assert.strictEqual(result, "file, Line 1: [Error] message (TS2322)");
	});

	it("single diagnostic without code → formatted line without code part", () => {
		const result = formatTscDiagnostics([
			{
				file: "file",
				line: 1,
				column: 1,
				severity: "Error" as const,
				message: "message",
				filePath: "/abs/file",
			},
		]);
		assert.strictEqual(result, "file, Line 1: [Error] message");
	});

	it("multiple files → grouped by file, blank line separator, files sorted", () => {
		const result = formatTscDiagnostics([
			{
				file: "b.ts",
				line: 1,
				column: 1,
				severity: "Error" as const,
				message: "msg2",
				filePath: "/abs/b.ts",
			},
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error" as const,
				message: "msg1",
				filePath: "/abs/a.ts",
			},
		]);
		assert.ok(result.includes("a.ts"));
		assert.ok(result.includes("b.ts"));
		// a.ts should come before b.ts (alphabetically)
		assert.ok(result.indexOf("a.ts") < result.indexOf("b.ts"));
	});

	it("same file, multiple diagnostics → sorted by line then column", () => {
		const result = formatTscDiagnostics([
			{
				file: "a.ts",
				line: 3,
				column: 5,
				severity: "Error" as const,
				message: "second",
				filePath: "/abs/a.ts",
			},
			{
				file: "a.ts",
				line: 1,
				column: 10,
				severity: "Error" as const,
				message: "first",
				filePath: "/abs/a.ts",
			},
		]);
		assert.ok(result.indexOf("first") < result.indexOf("second"));
	});

	it("message >500 chars → truncated to 497 + '...'", () => {
		const longMsg = "x".repeat(600);
		const result = formatTscDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error" as const,
				message: longMsg,
				filePath: "/abs/a.ts",
			},
		]);
		assert.ok(result.endsWith("..."));
		// The result should be: "a.ts, Line 1: [Error] " + truncated(497) + "..."
		const prefix = "a.ts, Line 1: [Error] ";
		const totalExpectedLen = prefix.length + 497 + "...".length;
		const msgPart = result.slice(prefix.length, -3);
		assert.strictEqual(msgPart.length, 497);
	});
});
