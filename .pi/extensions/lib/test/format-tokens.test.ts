/**
 * Canonical tests for lib/format-tokens.ts — the single home for token-count
 * display formatting — plus a structural guard that no second copy reappears.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/test/format-tokens.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatTokens, formatTokensInt } from "../format-tokens.ts";

describe("formatTokens", () => {
	it("returns raw values below 1000", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(42), "42");
		assert.equal(formatTokens(500), "500");
		assert.equal(formatTokens(999), "999");
	});

	it("formats the K tier with one decimal (uppercase)", () => {
		assert.equal(formatTokens(1_000), "1.0K");
		assert.equal(formatTokens(1_500), "1.5K");
		assert.equal(formatTokens(12_000), "12.0K");
		assert.equal(formatTokens(100_000), "100.0K");
	});

	it("rounds up across the K/M boundary but stays K", () => {
		assert.equal(formatTokens(999_999), "1000.0K");
	});

	it("formats the M tier with one decimal (uppercase)", () => {
		assert.equal(formatTokens(1_000_000), "1.0M");
		assert.equal(formatTokens(1_500_000), "1.5M");
		assert.equal(formatTokens(2_500_000), "2.5M");
		assert.equal(formatTokens(1_234_567), "1.2M");
	});
});

describe("formatTokensInt", () => {
	it("returns raw values below 1000", () => {
		assert.equal(formatTokensInt(0), "0");
		assert.equal(formatTokensInt(999), "999");
	});

	it("formats with lowercase suffix and zero decimals", () => {
		assert.equal(formatTokensInt(1_000), "1k");
		assert.equal(formatTokensInt(1_500), "2k");
		assert.equal(formatTokensInt(5_499), "5k");
		assert.equal(formatTokensInt(5_969), "6k");
		assert.equal(formatTokensInt(300_000), "300k");
		assert.equal(formatTokensInt(1_000_000), "1m");
		assert.equal(formatTokensInt(1_500_000), "2m");
		assert.equal(formatTokensInt(2_500_000), "3m");
	});
});

// ─── Structural guard: one definition, repo-wide ────────────────────────────

const EXTENSIONS_ROOT = resolve(import.meta.dirname, "..", "..");
const SELF = resolve(import.meta.dirname, "format-tokens.test.ts");

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

function countDefinition(token: string): number {
	let count = 0;
	for (const file of walk(EXTENSIONS_ROOT)) {
		if (file === SELF) continue;
		if (!/\.(m?ts)$/.test(file)) continue;
		for (const line of readFileSync(file, "utf-8").split("\n")) {
			if (line.includes(token)) count++;
		}
	}
	return count;
}

describe("single-definition guard", () => {
	it("formatTokens is defined exactly once under .pi/extensions", () => {
		assert.equal(countDefinition("function formatTokens("), 1);
	});

	it("formatTokensInt is defined at most once under .pi/extensions", () => {
		assert.ok(countDefinition("function formatTokensInt(") <= 1);
	});
});
