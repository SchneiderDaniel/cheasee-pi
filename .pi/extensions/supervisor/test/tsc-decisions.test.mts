/**
 * Tests for tsc-decisions (Tier 2 pipeline integration)
 *
 * Pure function tests for determineTscCheckpointDecision().
 * Types and formatTscDiagnostics imported from shared lib instead of
 * local duplication. Test body uses async function (matching production).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/tsc-decisions.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { determineTscCheckpointDecision } from "../checks/tsc-decisions.ts";
import {
	type TscDiagnostic,
	type TscCheckpointResult,
	type TscCheckpointDecision,
} from "../../lib/tsc-types.ts";
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

// ═══════════════════════════════════════════════════════════════════════
// determineTscCheckpointDecision tests
// ═══════════════════════════════════════════════════════════════════════

describe("determineTscCheckpointDecision", () => {
	it("intendedNext not Audit → pass through", async () => {
		const result = await determineTscCheckpointDecision(
			{ diagnostics: [], hasErrors: true },
			"Implementation",
		);
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.tscTriggered, false);
	});

	it("hasErrors → stay in Implementation", async () => {
		const result = await determineTscCheckpointDecision(
			{
				diagnostics: [
					{
						file: "a.ts",
						line: 1,
						column: 1,
						severity: "Error",
						message: "Type error",
						code: "TS2322",
						filePath: "/abs/a.ts",
					},
				],
				hasErrors: true,
			},
			"Audit",
		);
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.tscTriggered, true);
	});

	it("hasErrors → note includes diagnostics", async () => {
		const result = await determineTscCheckpointDecision(
			{
				diagnostics: [
					{
						file: "a.ts",
						line: 1,
						column: 1,
						severity: "Error",
						message: "Type error",
						code: "TS2322",
						filePath: "/abs/a.ts",
					},
				],
				hasErrors: true,
			},
			"Audit",
		);
		assert.ok(result.note.includes("Type error"));
		assert.ok(result.note.includes("TS2322"));
	});

	it("clean (no errors) → proceed to Audit", async () => {
		const result = await determineTscCheckpointDecision(
			{ diagnostics: [], hasErrors: false },
			"Audit",
		);
		assert.strictEqual(result.nextStatus, "Audit");
		assert.ok(result.note.includes("no type errors"));
	});

	it("null result → proceed to Audit with skip note", async () => {
		const result = await determineTscCheckpointDecision(null, "Audit");
		assert.strictEqual(result.nextStatus, "Audit");
		assert.ok(result.note.includes("skipped"));
		assert.strictEqual(result.tscTriggered, false);
	});

	it("empty diagnostics, hasErrors false → clean proceed", async () => {
		const result = await determineTscCheckpointDecision(
			{ diagnostics: [], hasErrors: false },
			"Audit",
		);
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.tscTriggered, true);
	});
});
