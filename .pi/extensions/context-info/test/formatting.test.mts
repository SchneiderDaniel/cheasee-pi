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
	pickThresholdColor,
	formatCacheStats,
	formatCacheHitRate,
	formatTps,
	computeTps,
} from "../formatting.ts";

// ─── Phase 1: threshold → semantic token mapping ────────────────────────────

describe("pickThresholdColor", () => {
	it("maps low→success, mid→warning, high→error (multi-tier)", () => {
		const thresholds = [{ maxTokens: 50_000 }, { maxTokens: 100_000 }, { maxTokens: null }];

		// Low tier (≤ 50K) → success
		assert.strictEqual(pickThresholdColor(10_000, thresholds), "success");
		assert.strictEqual(pickThresholdColor(50_000, thresholds), "success");

		// Mid tier (> 50K, ≤ 100K) → warning
		assert.strictEqual(pickThresholdColor(75_000, thresholds), "warning");
		assert.strictEqual(pickThresholdColor(100_000, thresholds), "warning");

		// Max tier (> 100K) → error
		assert.strictEqual(pickThresholdColor(150_000, thresholds), "error");
	});

	it("returns error for empty thresholds array", () => {
		assert.strictEqual(pickThresholdColor(50_000, []), "error");
	});

	it("single threshold: at/below → success, above → error", () => {
		const thresholds = [{ maxTokens: 100_000 }];
		assert.strictEqual(pickThresholdColor(0, thresholds), "success");
		assert.strictEqual(pickThresholdColor(100_000, thresholds), "success");
		assert.strictEqual(pickThresholdColor(100_001, thresholds), "error");
	});

	it("terminal null tier maps to error regardless of position", () => {
		assert.strictEqual(
			pickThresholdColor(500_000, [{ maxTokens: 100_000 }, { maxTokens: null }]),
			"error",
		);
	});

	it("sorts unsorted thresholds internally", () => {
		assert.strictEqual(
			pickThresholdColor(
				75_000,
				[{ maxTokens: 100_000 }, { maxTokens: 50_000 }, { maxTokens: null }],
			),
			"warning",
		);
	});

	it("always returns a valid token across a boundary sweep", () => {
		const thresholds = [{ maxTokens: 50_000 }, { maxTokens: 100_000 }, { maxTokens: null }];
		for (let t = 0; t <= 200_000; t += 10_000) {
			assert.ok(
				["success", "warning", "error"].includes(pickThresholdColor(t, thresholds)),
				`unexpected token for ${t}`,
			);
		}
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
});

// ─── Phase 1: removed color helpers are NOT statically importable ───────────
// Verified via dynamic import() because test files must NOT statically import
// the removed symbols (per project convention). The type-check confirms the
// removal: the export keyword is gone, so the symbols are module-private.

describe("removed color helper export removal", () => {
	it("fgHex, pickThresholdHex and THRESHOLD_HEX_COLORS are not public exports", async () => {
		const mod = await import("../formatting.ts");
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		assert.ok(!("THRESHOLD_HEX_COLORS" in mod), "THRESHOLD_HEX_COLORS should not be exported");
		assert.ok(!("fgHex" in mod), "fgHex should not be exported");
		assert.ok(!("pickThresholdHex" in mod), "pickThresholdHex should not be exported");
	});
});
