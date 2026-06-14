/**
 * Tests for waste-signals/structural-underuse.ts — detectStructuralSearchUnderuse
 *
 * Pure function: known input → expected WasteSignal[].
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/structural-underuse.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { detectStructuralSearchUnderuse } from "../waste-signals/structural-underuse.ts";
import {
	makeSession,
	readEntry,
	editEntry,
	writeEntry,
	structuralSearchEntry,
} from "./session-test-helpers.ts";

describe("detectStructuralSearchUnderuse", () => {
	it("3 distinct code file reads (.ts) → 1 signal", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
		]);
		assert.strictEqual(
			detectStructuralSearchUnderuse(data).length,
			1,
			"3 code file reads should fire",
		);
		assert.strictEqual(
			detectStructuralSearchUnderuse(data)[0].signal,
			"structural-search-underuse",
		);
	});

	it("3 code reads + 1 structural_search → 0 signals", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
			structuralSearchEntry(3),
		]);
		assert.strictEqual(
			detectStructuralSearchUnderuse(data).length,
			0,
			"structural_search should prevent signal",
		);
	});

	it("2 code reads → 0 signals (below threshold)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
		]);
		assert.strictEqual(
			detectStructuralSearchUnderuse(data).length,
			0,
			"2 code reads should not fire",
		);
	});

	it("3 non-code reads (.json, .yaml) → 0 signals", () => {
		const data = makeSession([
			readEntry("/repo/config.json", 0),
			readEntry("/repo/tsconfig.json", 1),
			readEntry("/repo/deploy.yaml", 2),
		]);
		assert.strictEqual(
			detectStructuralSearchUnderuse(data).length,
			0,
			"non-code file reads should not fire",
		);
	});

	it("3 code file edits (edit/write) → 1 signal", () => {
		const data = makeSession([
			editEntry("/repo/src/app.ts", 0),
			writeEntry("/repo/src/utils.ts", 1),
			editEntry("/repo/src/main.ts", 2),
		]);
		assert.strictEqual(
			detectStructuralSearchUnderuse(data).length,
			1,
			"3 code file edits should fire",
		);
	});

	it("2 code reads + 3 non-code reads → 0 signals", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/config.json", 2),
			readEntry("/repo/deploy.yaml", 3),
			readEntry("/repo/.env", 4),
		]);
		assert.strictEqual(
			detectStructuralSearchUnderuse(data).length,
			0,
			"2 code + 3 non-code should not fire",
		);
	});

	it("3 reads all on same file → 0 signals (redundant-read territory)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/app.ts", 1),
			readEntry("/repo/src/app.ts", 2),
		]);
		assert.strictEqual(
			detectStructuralSearchUnderuse(data).length,
			0,
			"3 reads on same file should not fire",
		);
	});

	it("empty session → 0 signals", () => {
		assert.strictEqual(detectStructuralSearchUnderuse(makeSession([])).length, 0);
	});

	it("only structural_search entries → 0 signals", () => {
		const data = makeSession([
			structuralSearchEntry(0),
			structuralSearchEntry(1),
			structuralSearchEntry(2),
		]);
		assert.strictEqual(detectStructuralSearchUnderuse(data).length, 0);
	});

	it("wastedTokens >= 0", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
		]);
		assert.strictEqual(detectStructuralSearchUnderuse(data).length, 1);
		assert.ok(
			detectStructuralSearchUnderuse(data)[0].wastedTokens >= 0,
			"wastedTokens should be non-negative",
		);
	});

	it("writeIfEmpty and editExisting count as code touches", () => {
		const data = makeSession([
			{
				type: "tool_use",
				toolName: "writeIfEmpty",
				args: { path: "/repo/src/new.ts" },
				text: "/repo/src/new.ts",
				turnIndex: 0,
			},
			{
				type: "tool_use",
				toolName: "editExisting",
				args: { path: "/repo/src/existing.ts" },
				text: "/repo/src/existing.ts",
				turnIndex: 1,
			},
			{
				type: "tool_use",
				toolName: "edit",
				args: { path: "/repo/src/another.ts" },
				text: "/repo/src/another.ts",
				turnIndex: 2,
			},
		]);
		assert.strictEqual(
			detectStructuralSearchUnderuse(data).length,
			1,
			"writeIfEmpty/editExisting/edit should count as code touches",
		);
	});

	it("context includes files list with unique paths", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
		]);
		assert.strictEqual(detectStructuralSearchUnderuse(data).length, 1);
		assert.ok(detectStructuralSearchUnderuse(data)[0].context.files, "should have files context");
		assert.ok(
			detectStructuralSearchUnderuse(data)[0].context.files!.length >= 3,
			"should list affected files",
		);
	});
});
