/**
 * Tests for trend.ts — TrendTracker pure module.
 *
 * Pure assertions on push/getTrend: improved/regressed/stable, bounded history,
 * <2 points returns undefined, zero-count edge cases.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/trend-tracker.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import { TrendTracker } from "../trend.ts";

// ═══════════════════════════════════════════════════════════════════════
// TrendTracker — Entity tests
// ═══════════════════════════════════════════════════════════════════════

describe("TrendTracker", () => {
	it("new TrendTracker() initializes empty bounded history", () => {
		const t = new TrendTracker();
		assert.strictEqual(t.historyLength, 0);
	});

	it("push(errorCount) stores count, getTrend() returns undefined when history length < 2", () => {
		const t = new TrendTracker();
		assert.strictEqual(t.getTrend(), undefined);
		t.push(5);
		assert.strictEqual(t.getTrend(), undefined);
	});

	it("getTrend() returns improved direction when current < previous", () => {
		const t = new TrendTracker();
		t.push(5);
		t.push(2);
		const trend = t.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "improved");
		assert.strictEqual(trend!.current, 2);
		assert.strictEqual(trend!.previous, 5);
		assert.strictEqual(trend!.delta, 3);
	});

	it("getTrend() returns regressed direction when current > previous", () => {
		const t = new TrendTracker();
		t.push(1);
		t.push(4);
		const trend = t.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "regressed");
		assert.strictEqual(trend!.current, 4);
		assert.strictEqual(trend!.previous, 1);
		assert.strictEqual(trend!.delta, 3);
	});

	it("getTrend() returns stable direction when current === previous", () => {
		const t = new TrendTracker();
		t.push(3);
		t.push(3);
		const trend = t.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "stable");
		assert.strictEqual(trend!.current, 3);
		assert.strictEqual(trend!.previous, 3);
		assert.strictEqual(trend!.delta, 0);
	});

	it("getTrend() returns correct delta = Math.abs(current - previous)", () => {
		const t = new TrendTracker();
		t.push(10);
		t.push(3);
		const trend = t.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.delta, 7);
		assert.strictEqual(trend!.direction, "improved");
	});

	it("bounded history evicts oldest entry when push exceeds MAX_TREND_HISTORY (default 50)", () => {
		const t = new TrendTracker();
		// Push 51 entries (one past the 50 limit)
		for (let i = 0; i < 51; i++) {
			t.push(i);
		}
		assert.strictEqual(t.historyLength, 50);
		// The oldest entry (0) should be evicted, newest (50) present
		const trend = t.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.current, 50);
		assert.strictEqual(trend!.previous, 49);
	});

	it("getTrend() uses only last two entries, not entire history", () => {
		const t = new TrendTracker();
		t.push(10);
		t.push(20);
		t.push(30);
		t.push(5);
		const trend = t.getTrend();
		assert.ok(trend);
		// Uses last two: 30 → 5 = improved
		assert.strictEqual(trend!.current, 5);
		assert.strictEqual(trend!.previous, 30);
		assert.strictEqual(trend!.direction, "improved");
	});

	it("consecutive pushes with identical count → stable, delta 0", () => {
		const t = new TrendTracker();
		t.push(7);
		t.push(7);
		let trend = t.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "stable");
		assert.strictEqual(trend!.delta, 0);

		t.push(7);
		trend = t.getTrend();
		assert.strictEqual(trend!.direction, "stable");
		assert.strictEqual(trend!.delta, 0);
	});

	it("boundary: zero error counts → correct trend (0 → 0 → stable, delta 0)", () => {
		const t = new TrendTracker();
		t.push(0);
		t.push(0);
		const trend = t.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "stable");
		assert.strictEqual(trend!.delta, 0);
		assert.strictEqual(trend!.current, 0);
		assert.strictEqual(trend!.previous, 0);
	});

	it("boundary: large error count changes", () => {
		const t = new TrendTracker();
		t.push(1);
		t.push(999999);
		const trend = t.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "regressed");
		assert.strictEqual(trend!.delta, 999998);
	});

	it("TrendTracker module is stateless singleton-safe (each instance has own history)", () => {
		const a = new TrendTracker();
		const b = new TrendTracker();

		a.push(10);
		a.push(5);

		// b has no history
		assert.strictEqual(b.getTrend(), undefined);

		// a has trend
		const trendA = a.getTrend();
		assert.ok(trendA);
		assert.strictEqual(trendA!.direction, "improved");
	});
});
