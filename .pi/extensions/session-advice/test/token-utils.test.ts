/**
 * Tests for token-utils.ts — token estimation helpers
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/token-utils.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { charsToTokens, sumTokenCost, sumDollarCost } from "../token-utils.ts";
import type { SessionEntry } from "../types.ts";

describe("charsToTokens", () => {
	it('returns 0 for empty string ""', () => {
		assert.strictEqual(charsToTokens(""), 0);
	});

	it('returns 1 for "abcd" (4 chars / 4)', () => {
		assert.strictEqual(charsToTokens("abcd"), 1);
	});

	it('returns 2 for "abcde" (5 chars / 4 → ceil)', () => {
		assert.strictEqual(charsToTokens("abcde"), 2);
	});

	it("handles nullish input as empty string", () => {
		assert.strictEqual(charsToTokens(undefined as unknown as string), 0);
		assert.strictEqual(charsToTokens(null as unknown as string), 0);
	});
});

describe("sumTokenCost", () => {
	it("returns 0 for empty array", () => {
		assert.strictEqual(sumTokenCost([]), 0);
	});

	it("returns assistantCost when present", () => {
		const entries: SessionEntry[] = [
			{
				type: "tool_use",
				toolName: "read",
				assistantCost: 150,
				turnIndex: 0,
			},
		];
		assert.strictEqual(sumTokenCost(entries), 150);
	});

	it("falls back to charsToTokens(entry.text) when no assistantCost but text exists", () => {
		// "/repo/file.ts" is 14 chars → ceil(14/4) = 4
		const entries: SessionEntry[] = [
			{
				type: "tool_use",
				toolName: "read",
				text: "/repo/file.ts",
				turnIndex: 0,
			},
		];
		// ceil(14/4) = 4
		assert.strictEqual(sumTokenCost(entries), 4);
	});

	it("falls back to 100 default overhead for entries with no assistantCost and no text", () => {
		const entries: SessionEntry[] = [
			{
				type: "tool_use",
				toolName: "read",
				text: "",
				turnIndex: 0,
			},
		];
		assert.strictEqual(sumTokenCost(entries), 100);
	});

	it("sums multiple entries", () => {
		const entries: SessionEntry[] = [
			{ type: "tool_use", toolName: "read", assistantCost: 100, turnIndex: 0 },
			{ type: "tool_use", toolName: "read", assistantCost: 200, turnIndex: 1 },
		];
		assert.strictEqual(sumTokenCost(entries), 300);
	});
});

describe("sumDollarCost", () => {
	it("returns 0 for empty array", () => {
		assert.strictEqual(sumDollarCost([]), 0);
	});

	it("returns usage.cost when present", () => {
		const entries: SessionEntry[] = [
			{
				type: "tool_use",
				toolName: "read",
				usage: { input: 10, output: 20, totalTokens: 30, cost: 0.001 },
				turnIndex: 0,
			},
		];
		assert.strictEqual(sumDollarCost(entries), 0.001);
	});

	it("returns 0 for entries without usage.cost", () => {
		const entries: SessionEntry[] = [
			{
				type: "tool_use",
				toolName: "read",
				turnIndex: 0,
			},
		];
		assert.strictEqual(sumDollarCost(entries), 0);
	});

	it("sums costs across multiple entries", () => {
		const entries: SessionEntry[] = [
			{
				type: "tool_use",
				toolName: "read",
				usage: { input: 10, output: 20, totalTokens: 30, cost: 0.001 },
				turnIndex: 0,
			},
			{
				type: "tool_use",
				toolName: "bash",
				usage: { input: 5, output: 10, totalTokens: 15, cost: 0.0005 },
				turnIndex: 1,
			},
		];
		assert.strictEqual(sumDollarCost(entries), 0.0015);
	});
});
