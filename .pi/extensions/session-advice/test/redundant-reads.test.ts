/**
 * Tests for waste-signals/redundant-reads.ts — detectRedundantReads
 *
 * Pure function: known input → expected WasteSignal[].
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/redundant-reads.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { detectRedundantReads } from "../waste-signals/redundant-reads.ts";
import { makeSession, readEntry, readToolResult, toolCallPair } from "./session-test-helpers.ts";

describe("detectRedundantReads", () => {
	it("same file read at turns 0 and 1 → 1 redundant-read signal", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0), readEntry("/repo/src/app.ts", 1)]);
		assert.strictEqual(detectRedundantReads(data).length, 1, "should flag redundant read");
		assert.strictEqual(detectRedundantReads(data)[0].signal, "redundant-read");
	});

	it("same file at turns 0 and 3 (distance >2) → 0 signals", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/app.ts", 3),
		]);
		assert.strictEqual(detectRedundantReads(data).length, 0, "3+ turns apart should not flag");
	});

	it("different files at consecutive turns → 0 signals", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
		]);
		assert.strictEqual(detectRedundantReads(data).length, 0);
	});

	it("3 reads of same file across turns 0,1,2 → 2 signals (each pair within 2-turn window)", () => {
		const signals = detectRedundantReads(
			makeSession([
				readEntry("/repo/src/app.ts", 0),
				readEntry("/repo/src/app.ts", 1),
				readEntry("/repo/src/app.ts", 2),
			]),
		);
		assert.strictEqual(signals.length, 2, "should produce 2 signals (1 per pair)");
		// Each signal's wastedTokens covers disjoint entry sets — no double-count.
		// Entry text is "/repo/src/app.ts" (15 chars) → ceil(15/4) = 4 tokens per entry.
		assert.strictEqual(signals[0].wastedTokens, 4, "signal1: redundant entry at turn 1 = 4 tokens");
		assert.strictEqual(signals[1].wastedTokens, 4, "signal2: redundant entry at turn 2 = 4 tokens");
	});

	it("3 reads with explicit assistantCost → no double-count", () => {
		const signals = detectRedundantReads(
			makeSession([
				{
					type: "tool_use",
					toolName: "read",
					args: { path: "/repo/src/app.ts" },
					text: "/repo/src/app.ts",
					turnIndex: 0,
					assistantCost: 100,
				},
				{
					type: "tool_use",
					toolName: "read",
					args: { path: "/repo/src/app.ts" },
					text: "/repo/src/app.ts",
					turnIndex: 1,
					assistantCost: 200,
				},
				{
					type: "tool_use",
					toolName: "read",
					args: { path: "/repo/src/app.ts" },
					text: "/repo/src/app.ts",
					turnIndex: 2,
					assistantCost: 300,
				},
			]),
		);
		assert.strictEqual(signals.length, 2, "should produce 2 signals");
		// Signal1: redundantEntries = [entry[1] (cost 200)] → wastedTokens = 200
		// Signal2: redundantEntries = [entry[2] (cost 300)] → wastedTokens = 300
		// No entry appears in both signals' redundantEntries.
		assert.strictEqual(signals[0].wastedTokens, 200, "signal1: entry[1] cost = 200");
		assert.strictEqual(signals[1].wastedTokens, 300, "signal2: entry[2] cost = 300");
	});

	it("4 reads of same file across turns 0,1,2,3 → 3 signals, each with one entry in redundantEntries", () => {
		const signals = detectRedundantReads(
			makeSession([
				readEntry("/repo/src/app.ts", 0),
				readEntry("/repo/src/app.ts", 1),
				readEntry("/repo/src/app.ts", 2),
				readEntry("/repo/src/app.ts", 3),
			]),
		);
		assert.strictEqual(signals.length, 3, "should produce 3 signals");
		// Each signal's redundantEntries contains exactly one entry.
		// Signal1: redundant = [turn 0] → redundantEntries = [entry[1]]
		// Signal2: redundant = [turn 1] (turn 0 reported) → redundantEntries = [entry[2]]
		// Signal3: redundant = [turn 2] (turns 0,1 reported) → redundantEntries = [entry[3]]
		for (let i = 0; i < 3; i++) {
			assert.strictEqual(signals[i].occurrences, 1, `signal${i}: occurrences should be 1`);
		}
	});

	it("exact 2-turn boundary: same file at turns 0 and 2 → 1 signal", () => {
		const signals = detectRedundantReads(
			makeSession([
				readEntry("/repo/src/app.ts", 0),
				{
					type: "tool_use",
					toolName: "bash",
					args: { command: "npm test" },
					text: "npm test",
					turnIndex: 0,
				},
				readEntry("/repo/src/app.ts", 2),
			]),
		);
		assert.strictEqual(signals.length, 1, "distance ≤ 2 should flag");
		// redundantEntries = [entry[2]] only, entry[0] excluded
		assert.strictEqual(signals[0].occurrences, 1, "should count 1 redundant occurrence");
	});

	it("gap then return: reads at turns 0, 3 (gap >2), 4 (within window of turn 3) → 1 signal", () => {
		const signals = detectRedundantReads(
			makeSession([
				readEntry("/repo/src/app.ts", 0),
				readEntry("/repo/src/app.ts", 3),
				readEntry("/repo/src/app.ts", 4),
			]),
		);
		assert.strictEqual(signals.length, 1, "only turn 4 is redundant with turn 3");
		// redundantEntries = [entry[4]] — turn 3 is baseline, turn 4 is waste
		assert.strictEqual(signals[0].occurrences, 1, "should count 1 redundant occurrence");
	});

	it("empty session → 0 signals", () => {
		assert.strictEqual(detectRedundantReads(makeSession([])).length, 0);
	});

	it("read entry without path arg → skipped (no crash)", () => {
		const data = makeSession([
			{ type: "tool_use", toolName: "read", args: {}, text: "", turnIndex: 0 },
			{ type: "tool_use", toolName: "read", args: {}, text: "", turnIndex: 1 },
		]);
		assert.strictEqual(detectRedundantReads(data).length, 0, "reads without path should not crash");
	});

	it("non-read tool entries in between → still detects across window", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			{
				type: "tool_use",
				toolName: "bash",
				args: { command: "npm test" },
				text: "npm test",
				turnIndex: 0,
			},
			readEntry("/repo/src/app.ts", 1),
		]);
		assert.strictEqual(
			detectRedundantReads(data).length,
			1,
			"should flag across 1 turn despite bash in between",
		);
	});

	// ── Regression: tool_result entries falsely flagged as reads ──

	it("tool_result entries (failure mode 1) → not flagged as reads", () => {
		// Turn 0: read /app.ts (tool_use) + tool_result with generic text
		// Turn 1: read /app.ts again (tool_use) + tool_result
		// Before fix: each tool_result's text becomes a false "path" via getEntryPath fallback → 2 signals
		// After fix: only tool_use entries are considered → 1 signal
		const data = makeSession([
			...toolCallPair("read", 0, { path: "/repo/src/app.ts" }),
			...toolCallPair("read", 1, { path: "/repo/src/app.ts" }),
		]);
		// Replace tool_result text with realistic file content to match issue reproduction
		data.entries[1] = readToolResult(0, "file content here...");
		data.entries[3] = readToolResult(1, "file content here...");
		assert.strictEqual(detectRedundantReads(data).length, 1, "only tool_use entries should produce signals");
	});

	it("tool_result text matching later path (failure mode 2) → not flagged", () => {
		// Turn 0: tool_use read /repo/a.ts + tool_result with text accidentally set to /repo/b.ts
		// Turn 1: tool_use read /repo/b.ts (different file)
		// Before fix: /repo/b.ts from turn 0's tool_result text matches turn 1's path → 1 false signal
		// After fix: tool_result entries are ignored → 0 signals
		const data = makeSession([
			readEntry("/repo/a.ts", 0),
			readToolResult(0, "/repo/b.ts"),
			readEntry("/repo/b.ts", 1),
		]);
		assert.strictEqual(detectRedundantReads(data).length, 0, "different files should not produce signals");
	});
});
