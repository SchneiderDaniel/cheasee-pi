/**
 * Tests: formatting.ts — formatTokensInt helper (integer-rounded, lowercase k/m)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/formatting.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTokensInt } from "../lib/formatting.ts";

describe("formatTokensInt", () => {
	// ── Sub-1000: raw number ────────────────────────────────────
	it("0 returns '0'", () => {
		assert.equal(formatTokensInt(0), "0");
	});

	it("500 returns '500'", () => {
		assert.equal(formatTokensInt(500), "500");
	});

	it("999 returns '999'", () => {
		assert.equal(formatTokensInt(999), "999");
	});

	// ── Thousands: integer-rounded, lowercase k ────────────────
	it("1000 returns '1k'", () => {
		assert.equal(formatTokensInt(1000), "1k");
	});

	it("1500 returns '2k' (rounds up)", () => {
		assert.equal(formatTokensInt(1500), "2k");
	});

	it("5499 returns '5k' (rounding boundary)", () => {
		assert.equal(formatTokensInt(5499), "5k");
	});

	it("5969 returns '6k' (matches bug report example)", () => {
		assert.equal(formatTokensInt(5969), "6k");
	});

	it("300_000 returns '300k' (no decimal, no uppercase K)", () => {
		assert.equal(formatTokensInt(300_000), "300k");
	});

	// ── Millions: integer-rounded, lowercase m ─────────────────
	it("1_000_000 returns '1m'", () => {
		assert.equal(formatTokensInt(1_000_000), "1m");
	});

	it("1_500_000 returns '2m' (million with rounding)", () => {
		assert.equal(formatTokensInt(1_500_000), "2m");
	});

	it("2_500_000 returns '3m' (banker's rounding: 2.5 → toFixed(0) → '3')", () => {
		assert.equal(formatTokensInt(2_500_000), "3m");
	});
});
