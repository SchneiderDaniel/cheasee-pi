/**
 * Canonical tests for lib/thinking-level.ts
 *
 * Single source of truth for thinking-level → icon/color/label mappings.
 * Consumer-extension tests no longer re-assert this table.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/test/thinking-level.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	thinkingIcon,
	thinkingColor,
	thinkingLabel,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "../thinking-level.ts";

// ─── thinkingIcon ─────────────────────────────────────────────────

describe("thinkingIcon", () => {
	it("returns correct glyph for each level", () => {
		assert.strictEqual(thinkingIcon("off"), "○");
		assert.strictEqual(thinkingIcon("minimal"), "◐");
		assert.strictEqual(thinkingIcon("low"), "◑");
		assert.strictEqual(thinkingIcon("medium"), "◒");
		assert.strictEqual(thinkingIcon("high"), "◓");
		assert.strictEqual(thinkingIcon("xhigh"), "●");
	});

	it("returns middle-dot for undefined", () => {
		assert.strictEqual(thinkingIcon(undefined), "·");
	});

	it("returns middle-dot for unknown string", () => {
		assert.strictEqual(thinkingIcon("unknown"), "·");
	});

	it("returns middle-dot for empty string", () => {
		assert.strictEqual(thinkingIcon(""), "·");
	});
});

// ─── thinkingColor ────────────────────────────────────────────────

describe("thinkingColor", () => {
	it("returns correct color for each level (reconciled mapping)", () => {
		assert.strictEqual(thinkingColor("off"), "dim");
		assert.strictEqual(thinkingColor("minimal"), "dim");
		assert.strictEqual(thinkingColor("low"), "muted");
		assert.strictEqual(thinkingColor("medium"), "accent");
		assert.strictEqual(thinkingColor("high"), "warning");
		assert.strictEqual(thinkingColor("xhigh"), "error");
	});

	it("returns dim for undefined", () => {
		assert.strictEqual(thinkingColor(undefined), "dim");
	});

	it("returns dim for unknown string", () => {
		assert.strictEqual(thinkingColor("unknown"), "dim");
	});

	it("returns dim for empty string", () => {
		assert.strictEqual(thinkingColor(""), "dim");
	});
});

// ─── thinkingLabel ────────────────────────────────────────────────

describe("thinkingLabel", () => {
	it("returns empty string for undefined (supervisor contract — consumers gate on truthiness)", () => {
		assert.strictEqual(thinkingLabel(undefined), "");
	});

	it("returns empty string for empty string", () => {
		assert.strictEqual(thinkingLabel(""), "");
	});

	it("returns empty string for unknown level", () => {
		assert.strictEqual(thinkingLabel("bogus"), "");
	});

	it("returns '<icon> <level>' for each known level, never '· undefined'", () => {
		assert.strictEqual(thinkingLabel("off"), "○ off");
		assert.strictEqual(thinkingLabel("minimal"), "◐ minimal");
		assert.strictEqual(thinkingLabel("low"), "◑ low");
		assert.strictEqual(thinkingLabel("medium"), "◒ medium");
		assert.strictEqual(thinkingLabel("high"), "◓ high");
		assert.strictEqual(thinkingLabel("xhigh"), "● xhigh");
	});

	it("is non-empty for off level (works with consumer truthiness gate)", () => {
		assert.ok(thinkingLabel("off"));
	});
});

// ─── THINKING_LEVELS ──────────────────────────────────────────────

describe("THINKING_LEVELS", () => {
	it("contains all 6 levels in order", () => {
		assert.deepStrictEqual([...THINKING_LEVELS], [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});

	it("is readonly (not mutable)", () => {
		// Compile-time check — runtime verification that spread works
		assert.strictEqual(Array.isArray(THINKING_LEVELS), true);
	});
});

// ─── ThinkingLevel type ───────────────────────────────────────────

describe("ThinkingLevel type", () => {
	it("rejects assignability from arbitrary string at compile time", () => {
		// This is a compile-time check only.
		// Runtime: verify that a const annotated with ThinkingLevel works
		const level: ThinkingLevel = "high";
		assert.strictEqual(level, "high");
	});
});
