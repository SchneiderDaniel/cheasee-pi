/**
 * Tests for session-logger/stats.ts — usage aggregation
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-stats.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createSessionStats, computeToolStats } from "../stats.ts";
import type { Usage } from "@earendil-works/pi-ai";

// Split from session-logger-stats.test.mts (issue #2035 Long File refactor).
// ---------------------------------------------------------------------------
// createSessionStats — nested call attribution (derived from the id suffix)
// ---------------------------------------------------------------------------

describe("createSessionStats — nested call attribution", () => {
	it("top-level tool start carries no parentToolCallId", () => {
		const stats = createSessionStats();
		stats.recordToolStart("read_1", "read");
		const exec = stats.getSnapshot().toolExecutions[0];
		assert.strictEqual(exec.parentToolCallId, undefined);
		// and it is still aggregated as a top-level tool
		assert.strictEqual(computeToolStats([exec]).read.calls, 1);
	});

	it("nested id derives its parent by slicing at the last slash", () => {
		const stats = createSessionStats();
		stats.recordToolStart("codemode_1/1", "read");
		assert.strictEqual(stats.getSnapshot().toolExecutions[0].parentToolCallId, "codemode_1");
	});

	it("recursive nested id derives the immediate parent", () => {
		const stats = createSessionStats();
		stats.recordToolStart("codemode_1/1/1", "grep");
		assert.strictEqual(stats.getSnapshot().toolExecutions[0].parentToolCallId, "codemode_1/1");
	});

	it("computeToolStats excludes nested execs — no orphan rows, zero contribution", () => {
		const stats = createSessionStats();
		stats.recordToolStart("codemode_1", "codemode");
		stats.recordToolStart("codemode_1/1", "read");
		stats.recordToolStart("call_abc", "read");
		stats.recordToolEnd("codemode_1", true, 10);
		stats.recordToolEnd("codemode_1/1", true, 5);
		stats.recordToolEnd("call_abc", false, 3);

		const result = computeToolStats(stats.getSnapshot().toolExecutions);
		assert.deepStrictEqual(Object.keys(result).sort(), ["codemode", "read"]);
		assert.strictEqual(result.codemode.calls, 1);
		assert.strictEqual(result.codemode.errors, 1);
		// nested read errors/duration must NOT inflate the top-level read entry
		assert.strictEqual(result.read.calls, 1);
		assert.strictEqual(result.read.errors, 0);
	});

	it("nested recordToolEnd tags the exec but does not increment per-turn counts", () => {
		const stats = createSessionStats();
		stats.recordTurnStart(0);
		stats.recordToolStart("codemode_1", "codemode");
		stats.recordToolStart("codemode_1/1", "read");
		stats.recordToolStart("codemode_1/2", "grep");
		stats.recordToolEnd("codemode_1", false, 10);
		stats.recordToolEnd("codemode_1/1", true, 5);
		stats.recordToolEnd("codemode_1/2", false, 2);
		stats.recordTurnEnd();

		const snap = stats.getSnapshot();
		const nested = snap.toolExecutions.find((e) => e.toolCallId === "codemode_1/1")!;
		assert.strictEqual(nested.isError, true);
		assert.ok(nested.endTime != null, "nested exec still gets an endTime");
		assert.strictEqual(snap.perTurnTokens[0].toolCount, 1, "only the top-level call counts");
		assert.strictEqual(snap.perTurnTokens[0].errorCount, 0, "nested error does not leak");
	});

	it("reset clears tagged nested execs", () => {
		const stats = createSessionStats();
		stats.recordToolStart("codemode_1/1", "read");
		stats.reset();
		assert.strictEqual(stats.getSnapshot().toolExecutions.length, 0);
	});
});
