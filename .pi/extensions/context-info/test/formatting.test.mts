/**
 * Tests for context-info formatting.ts — threshold hex colors and public exports
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/formatting.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	formatSessionTimer,
	formatTokens,
	fgHex,
	pickThresholdHex,
	formatCacheStats,
	formatCacheHitRate,
	formatTps,
	computeTps,
	thinkingIcon,
	thinkingColor,
} from "../formatting.ts";

// ─── Phase 1: Behavior unchanged after export removal ───────────────────────

describe("pickThresholdHex", () => {
	it("returns green for low tokens, orange for mid, red for crossing max (multi-tier)", () => {
		const thresholds = [
			{ label: "mid", maxTokens: 50_000 },
			{ label: "high", maxTokens: 100_000 },
			{ label: "max", maxTokens: null },
		];

		// Low tier (≤ 50K) → green (#50fa7b)
		assert.strictEqual(pickThresholdHex(10_000, thresholds), "#50fa7b");
		assert.strictEqual(pickThresholdHex(50_000, thresholds), "#50fa7b");

		// Mid tier (> 50K, ≤ 100K) → orange (#ff6d00)
		assert.strictEqual(pickThresholdHex(75_000, thresholds), "#ff6d00");
		assert.strictEqual(pickThresholdHex(100_000, thresholds), "#ff6d00");

		// Max tier (> 100K) → red (#ff5252)
		assert.strictEqual(pickThresholdHex(150_000, thresholds), "#ff5252");
	});

	it("returns fallback red (#ff5252) for empty thresholds array", () => {
		assert.strictEqual(pickThresholdHex(50_000, []), "#ff5252");
	});

	it("returns green when tokens ≤ maxTokens, red when above, for single threshold", () => {
		const thresholds = [{ label: "cap", maxTokens: 100_000 }];

		// At or below boundary → green
		assert.strictEqual(pickThresholdHex(0, thresholds), "#50fa7b");
		assert.strictEqual(pickThresholdHex(100_000, thresholds), "#50fa7b");

		// Above boundary → red (falls through to last color)
		assert.strictEqual(pickThresholdHex(100_001, thresholds), "#ff5252");
	});
});

// ─── Phase 1: Other formatting exports still work ───────────────────────────

describe("public formatting exports", () => {
	it("formatSessionTimer formats correctly", () => {
		assert.strictEqual(formatSessionTimer(0), "⏱ 0s");
		assert.strictEqual(formatSessionTimer(1000), "⏱ 1s");
		assert.strictEqual(formatSessionTimer(61_000), "⏱ 1m 1s");
		assert.strictEqual(formatSessionTimer(3_661_000), "⏱ 1h 1m 1s");
	});

	it("formatTokens formats correctly", () => {
		assert.strictEqual(formatTokens(500), "500");
		assert.strictEqual(formatTokens(1500), "1.5K");
		assert.strictEqual(formatTokens(1_500_000), "1.5M");
	});

	it("fgHex applies ANSI truecolor escape codes", () => {
		assert.strictEqual(fgHex("#ff0000", "hello"), "\x1b[38;2;255;0;0mhello\x1b[39m");
		assert.strictEqual(fgHex("invalid", "text"), "text");
	});

	it("formatCacheStats formats correctly", () => {
		assert.strictEqual(formatCacheStats(1000, 500), "📦 1.0K/500");
		assert.strictEqual(formatCacheStats(null, null), "📦 --/--");
		assert.strictEqual(formatCacheStats(undefined, undefined), "📦 --/--");
	});

	it("formatCacheHitRate formats correctly", () => {
		assert.strictEqual(formatCacheHitRate(75.3), "CH: 75%");
		assert.strictEqual(formatCacheHitRate(undefined), "");
		assert.strictEqual(formatCacheHitRate(NaN), "");
	});

	it("formatTps formats correctly", () => {
		assert.strictEqual(formatTps(null), "-- t/s");
		assert.strictEqual(formatTps(0.05), "0.0 t/s");
		assert.strictEqual(formatTps(42.5), "42.5 t/s");
		assert.strictEqual(formatTps(1000), "1000 t/s");
	});

	it("computeTps returns null for insufficient samples", () => {
		assert.strictEqual(computeTps([]), null);
		assert.strictEqual(computeTps([{ time: 100, cumulativeTokens: 0 }]), null);
	});

	it("thinkingIcon returns correct icons", () => {
		assert.strictEqual(thinkingIcon("off"), "○");
		assert.strictEqual(thinkingIcon("high"), "◓");
		assert.strictEqual(thinkingIcon(undefined), "·");
	});

	it("thinkingColor returns correct colors", () => {
		assert.strictEqual(thinkingColor("off"), "dim");
		assert.strictEqual(thinkingColor("high"), "warning");
		assert.strictEqual(thinkingColor(undefined), "dim");
	});
});

// ─── Phase 2: THRESHOLD_HEX_COLORS is NOT statically importable ─────────────
// We verify via dynamic import() because test files must NOT statically import
// the removed symbol (per project convention). The type-check confirms the
// removal: the export keyword is gone, so the symbol is module-private.

describe("THRESHOLD_HEX_COLORS export removal", () => {
	it("THRESHOLD_HEX_COLORS is not exported from formatting module", async () => {
		const mod = await import("../formatting.ts");
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		assert.ok(
			!("THRESHOLD_HEX_COLORS" in mod),
			"THRESHOLD_HEX_COLORS should not be a public export",
		);
	});
});
