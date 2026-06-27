/**
 * Tests for waste-signals/identical-args.ts — detectIdenticalArgs
 *
 * Pure function: known input → expected WasteSignal[].
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/identical-args.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { detectIdenticalArgs } from "../waste-signals/identical-args.ts";
import {
	makeSession,
	identicalBashEntry,
	identicalStructuralSearchEntry,
	toolCallPair,
} from "./session-test-helpers.ts";

describe("detectIdenticalArgs", () => {
	it("3 identical bash calls → 1 signal with occurrences >= 2", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		assert.strictEqual(
			detectIdenticalArgs(data).length,
			1,
			"should produce one identical-args signal",
		);
		assert.ok(detectIdenticalArgs(data)[0].occurrences >= 2, "occurrences should be >= 2");
		assert.strictEqual(detectIdenticalArgs(data)[0].context.toolName, "bash");
	});

	it("2 identical calls → 0 signals (below threshold)", () => {
		assert.strictEqual(
			detectIdenticalArgs(makeSession([identicalBashEntry("ls", 0), identicalBashEntry("ls", 0)]))
				.length,
			0,
			"2 identical calls should not trigger",
		);
	});

	it("5 identical calls → 1 signal (not duplicated per-call)", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		assert.strictEqual(
			detectIdenticalArgs(data).length,
			1,
			"5 identical calls should produce exactly 1 signal",
		);
	});

	it(">12 calls with first 3 pushed out → only first batch triggers", () => {
		const entries: Array<ReturnType<typeof identicalBashEntry>> = [
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		];
		for (let i = 3; i < 13; i++) {
			entries.push(identicalBashEntry(`unique-${i}`, 0));
		}
		entries.push(identicalBashEntry("ls", 0));
		entries.push(identicalBashEntry("ls", 0));

		assert.strictEqual(
			detectIdenticalArgs(makeSession(entries)).length,
			1,
			"only the first batch of 3 should trigger a signal",
		);
	});

	it("3 identical calls interleaved with other tools → still detected", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalStructuralSearchEntry(0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		assert.strictEqual(
			detectIdenticalArgs(data).length,
			1,
			"interleaved identical calls should be detected",
		);
	});

	it("same tool but different args → 0 signals (key mismatch)", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls -la", 0),
			identicalBashEntry("ls", 0),
		]);
		assert.strictEqual(detectIdenticalArgs(data).length, 0, "different args should not match");
	});

	it("different tool but same args structure → 0 signals (key includes toolName)", () => {
		const data = makeSession([
			{ type: "tool_use", toolName: "bash", args: { command: "ls" }, text: "ls", turnIndex: 0 },
			{ type: "tool_use", toolName: "read", args: { command: "ls" }, text: "", turnIndex: 0 },
			{ type: "tool_use", toolName: "bash", args: { command: "ls" }, text: "ls", turnIndex: 0 },
		]);
		assert.strictEqual(
			detectIdenticalArgs(data).length,
			0,
			"different tools should not match even with same args",
		);
	});

	it("entries with undefined toolName or args → filtered, no crash", () => {
		const data = makeSession([
			{
				type: "tool_use",
				toolName: undefined,
				args: { command: "ls" },
				text: "",
				turnIndex: 0,
			} as any,
			{ type: "tool_use", toolName: "bash", args: undefined, text: "", turnIndex: 0 } as any,
			{ type: "tool_use", toolName: undefined, args: undefined, text: "", turnIndex: 0 } as any,
		]);
		assert.ok(Array.isArray(detectIdenticalArgs(data)), "should return array without crashing");
	});

	it("3 identical calls with interleaved tool_result entries → count not inflated (#1096)", () => {
		// toolCallPair sets args: {} on tool_result — latent inflation vector
		const data = makeSession([
			...toolCallPair("read", 0, { path: "/a.ts" }),
			...toolCallPair("read", 1, { path: "/a.ts" }),
			...toolCallPair("read", 2, { path: "/a.ts" }),
		]);
		const signals = detectIdenticalArgs(data);
		// Should detect 3 tool_use entries with identical args (path: "/a.ts")
		assert.strictEqual(signals.length, 1, "should produce one identical-args signal");
		assert.ok(signals[0].occurrences >= 2, "occurrences should be >= 2");
	});

	it("empty session → 0 signals", () => {
		assert.strictEqual(detectIdenticalArgs(makeSession([])).length, 0);
	});

	it("regression: tool_result pairs with empty args → 0 signals", () => {
		const pairs = [
			...toolCallPair("read", 0, { path: "/a.ts" }),
			...toolCallPair("read", 1, { path: "/b.ts" }),
			...toolCallPair("read", 2, { path: "/c.ts" }),
		];
		const data = makeSession(pairs);
		assert.strictEqual(detectIdenticalArgs(data).length, 0);
	});

	it("regression: mixed tool_use + tool_result — real identical calls still detected", () => {
		const entries = [
			identicalBashEntry("ls", 0),
			...toolCallPair("bash", 1),
			identicalBashEntry("ls", 0),
			...toolCallPair("bash", 1),
			identicalBashEntry("ls", 0),
			...toolCallPair("bash", 1),
		];
		const data = makeSession(entries);
		assert.strictEqual(detectIdenticalArgs(data).length, 1);
	});

	it("6 identical calls → 2 separate signals (no dedup within individual detector)", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		assert.strictEqual(
			detectIdenticalArgs(data).length,
			2,
			"6 identical calls should produce 2 signals (2 batches)",
		);
		assert.ok(
			detectIdenticalArgs(data).reduce((s, sig) => s + sig.occurrences, 0) >= 4,
			"total occurrences should account for both batches (>= 4)",
		);
	});
});
