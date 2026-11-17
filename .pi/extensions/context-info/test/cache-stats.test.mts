/**
 * Tests for context-info cache-stats.ts — the cache hit-rate policy (issue #2136).
 *
 * The metric this module owns is deliberately narrow: the share of *reported*
 * prompt tokens that were served from cache:
 *
 *     cacheRead / (input + cacheRead + cacheWrite) * 100
 *
 * `input` is in the denominator on purpose. The old formula
 * `cacheRead / (cacheRead + cacheWrite)` claimed 100% whenever a provider
 * reported positive `cacheRead` and zero `cacheWrite`, which says nothing
 * about cache-eligible prompt tokens that were neither read nor written.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/cache-stats.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import { computeCacheHitRate } from "../cache-stats.ts";

/** The issue's own example: displayed counts 11.4K/1.2K. */
const ISSUE_USAGE = { input: 1000, cacheRead: 11400, cacheWrite: 1200 };

describe("computeCacheHitRate — new denominator", () => {
	it("counts input together with cacheRead and cacheWrite", () => {
		const rate = computeCacheHitRate(ISSUE_USAGE);
		assert.ok(rate !== undefined, "rate must be defined for a full usage record");
		// 11400 / (1000 + 11400 + 1200) * 100 = 83.8235...
		assert.ok(Math.abs(rate - 83.82) < 0.01, `expected ~83.82, got ${rate}`);
	});

	it("no longer matches the old read-share formula (the 91% example from the issue)", () => {
		// Old formula: 11400 / (11400 + 1200) * 100 = 90.476...
		const oldFormula = (11400 / (11400 + 1200)) * 100;
		assert.ok(Math.abs(oldFormula - 90.48) < 0.01, "fixture sanity: old formula is ~90.48");

		const rate = computeCacheHitRate(ISSUE_USAGE);
		assert.ok(rate !== undefined);
		assert.ok(
			Math.abs(rate - oldFormula) > 0.5,
			`new rate ${rate} must not reproduce the old ${oldFormula}`,
		);
	});
});

describe("computeCacheHitRate — zero cacheWrite is not 100%", () => {
	it("zero cacheWrite with positive input stays below 100", () => {
		const rate = computeCacheHitRate({ input: 1000, cacheRead: 5000, cacheWrite: 0 });
		assert.ok(rate !== undefined);
		// 5000 / 6000 * 100 = 83.333...
		assert.ok(Math.abs(rate - 83.33) < 0.01, `expected ~83.33, got ${rate}`);
		assert.ok(rate < 100, `zero cacheWrite must not report 100%, got ${rate}`);
	});

	it("zero cacheRead and zero cacheWrite yields 0, not undefined", () => {
		// Input alone is a meaningful (zero-hit) denominator.
		assert.strictEqual(computeCacheHitRate({ input: 200, cacheRead: 0, cacheWrite: 0 }), 0);
	});
});

describe("computeCacheHitRate — 100% only when input is 0", () => {
	it("input 0 with positive cacheRead is the documented 100% case", () => {
		assert.strictEqual(computeCacheHitRate({ input: 0, cacheRead: 5000, cacheWrite: 0 }), 100);
	});

	it("any positive input pulls the rate below 100", () => {
		const rate = computeCacheHitRate({ input: 1, cacheRead: 5000, cacheWrite: 0 });
		assert.ok(rate !== undefined);
		assert.ok(rate < 100, `expected < 100 with input > 0, got ${rate}`);
	});
});

describe("computeCacheHitRate — unavailable cases", () => {
	it("all-zero usage → undefined (zero denominator, not 0 and not 100)", () => {
		const rate = computeCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 });
		assert.strictEqual(rate, undefined);
	});

	it("undefined / null / NaN fields → undefined without throwing", () => {
		const broken: unknown[] = [
			{ input: undefined, cacheRead: 100, cacheWrite: 0 },
			{ input: 100, cacheRead: undefined, cacheWrite: 0 },
			{ input: 100, cacheRead: 100, cacheWrite: undefined },
			{ input: null, cacheRead: 100, cacheWrite: 0 },
			{ input: 100, cacheRead: null, cacheWrite: 0 },
			{ input: 100, cacheRead: 100, cacheWrite: null },
			{ input: Number.NaN, cacheRead: 100, cacheWrite: 0 },
			{ input: 100, cacheRead: Number.NaN, cacheWrite: 0 },
			{ input: 100, cacheRead: 100, cacheWrite: Number.NaN },
			{},
			undefined,
			null,
		];
		for (const usage of broken) {
			assert.doesNotThrow(() => computeCacheHitRate(usage as never));
			assert.strictEqual(
				computeCacheHitRate(usage as never),
				undefined,
				`expected undefined for ${JSON.stringify(usage)}`,
			);
		}
	});

	it("negative or non-finite counts → undefined (never a bogus percentage)", () => {
		assert.strictEqual(
			computeCacheHitRate({ input: -100, cacheRead: 50, cacheWrite: 0 }),
			undefined,
		);
		assert.strictEqual(
			computeCacheHitRate({ input: 100, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 0 }),
			undefined,
		);
	});
});
