/**
 * Tests for waste-signals/no-batch.ts — detectNoBatch
 *
 * Pure function: known input → expected WasteSignal[].
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/no-batch.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { detectNoBatch } from "../waste-signals/no-batch.ts";
import { makeSession, readEntry, toolCallPair } from "./session-test-helpers.ts";

describe("detectNoBatch", () => {
	it("3 consecutive read calls across turns 0,1,2 → 1 no-batch signal", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
		]);
		assert.strictEqual(
			detectNoBatch(data).length,
			1,
			"should flag 3 consecutive calls across turns",
		);
		assert.strictEqual(detectNoBatch(data)[0].signal, "no-batch");
		assert.strictEqual(detectNoBatch(data)[0].occurrences, 2, "extra turns = 2");
	});

	it("3 consecutive reads in same turn → 0 signals (already batched)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 0),
			readEntry("/repo/src/main.ts", 0),
		]);
		assert.strictEqual(detectNoBatch(data).length, 0, "same turn = already batched");
	});

	it("2 consecutive reads → 0 signals (below threshold)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
		]);
		assert.strictEqual(detectNoBatch(data).length, 0, "2 calls below threshold of 3");
	});

	it("read-write-read interleaved → 0 signals (not consecutive same tool)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			{
				type: "tool_use",
				toolName: "write",
				args: { path: "/repo/src/app.ts" },
				text: "/repo/src/app.ts",
				turnIndex: 1,
			},
			readEntry("/repo/src/utils.ts", 2),
		]);
		assert.strictEqual(detectNoBatch(data).length, 0, "interleaved tools break the run");
	});

	it("5 consecutive reads across 4 turns → occurrences = 3", () => {
		const data = makeSession([
			readEntry("/repo/src/a.ts", 0),
			readEntry("/repo/src/b.ts", 1),
			readEntry("/repo/src/c.ts", 2),
			readEntry("/repo/src/d.ts", 3),
			readEntry("/repo/src/e.ts", 3),
		]);
		assert.strictEqual(detectNoBatch(data).length, 1, "should flag 5 consecutive calls");
		assert.ok(detectNoBatch(data)[0].occurrences >= 3, "extra turns should be >= 3");
	});

	it("context.toolName matches the repeated tool", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
		]);
		assert.strictEqual(detectNoBatch(data).length, 1);
		assert.strictEqual(detectNoBatch(data)[0].context.toolName, "read");
	});

	it("3 consecutive reads with interleaved tool_result entries → count is 3 not 6 (#1096)", () => {
		const data = makeSession([
			...toolCallPair("read", 0, { path: "/a.ts" }),
			...toolCallPair("read", 1, { path: "/b.ts" }),
			...toolCallPair("read", 2, { path: "/c.ts" }),
		]);
		const signals = detectNoBatch(data);
		assert.strictEqual(signals.length, 1, "should flag 3 consecutive calls");
		assert.match(
			signals[0].details[0],
			/`read` called 3x consecutively/,
			"detail should say 3x, not 6x",
		);
	});

	it("empty session → 0 signals", () => {
		assert.strictEqual(detectNoBatch(makeSession([])).length, 0);
	});
});
