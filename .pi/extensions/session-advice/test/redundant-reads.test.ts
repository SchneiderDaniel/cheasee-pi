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
import { makeSession, readEntry } from "./session-test-helpers.ts";

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
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/app.ts", 1),
			readEntry("/repo/src/app.ts", 2),
		]);
		assert.strictEqual(
			detectRedundantReads(data).length,
			2,
			"should produce 2 signals (1 per pair)",
		);
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
});
