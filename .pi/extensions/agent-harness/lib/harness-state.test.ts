/**
 * Tests for harness-state.ts — integration-scoped factory tests.
 *
 * Shallow per-interface unit tests removed (covered by
 * .pi/lib/timed-map.test.ts for generic TimedMap behavior and by AgentHarness
 * integration tests for specialized wrapper behavior).
 *
 * Keeps:
 *  - HarnessState factory isolation tests
 *  - Constants sanity check
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessState, CACHE_TTL_MS } from "./harness-state.ts";
import { CACHE_TTL_TURNS } from "./harness-rules.ts";

// ── HarnessState ──

describe("HarnessState", () => {
	it("createHarnessState exports the factory function", () => {
		assert.equal(typeof createHarnessState, "function");
	});

	it("CACHE_TTL_MS exports a positive number", () => {
		assert.equal(typeof CACHE_TTL_MS, "number");
		assert.ok(CACHE_TTL_MS > 0);
	});

	it("createHarnessState returns isolated state", () => {
		const s1 = createHarnessState();
		const s2 = createHarnessState();

		s1.toolCallIndex = 5;
		s1.readCache.set("k", 0);

		assert.equal(s2.toolCallIndex, 0);
		assert.equal(s2.readCache.get("k", 0), null);
	});

	it("toolCallIndex starts at 0", () => {
		const state = createHarnessState();
		assert.equal(state.toolCallIndex, 0);
	});

	it("sessionTurn starts at 0", () => {
		const state = createHarnessState();
		assert.equal(state.sessionTurn, 0);
	});

	it("toolCallIndex and sessionTurn are independent", () => {
		const state = createHarnessState();
		state.toolCallIndex = 5;
		assert.equal(state.sessionTurn, 0); // not affected

		state.sessionTurn = 3;
		assert.equal(state.toolCallIndex, 5); // not affected
	});

});

// ── CACHE_TTL_TURNS ──

describe("Constants", () => {
	it("CACHE_TTL_TURNS is at least 6", () => {
		assert.ok(CACHE_TTL_TURNS >= 6);
	});
});

// ── Nested-call attribution (callIdIndex + callCounter.recordNested) ──

describe("HarnessState — nested call attribution", () => {
	it("callIdIndex resolves a registered tool-call id to its composite identity", () => {
		const s = createHarnessState();
		s.callIdIndex.set("id1", { toolName: "read" }, 0);
		assert.equal(s.callIdIndex.get("id1", 0)?.toolName, "read");
		s.callIdIndex.set("id2", { toolName: "bash", subKey: "git commit" }, 0);
		assert.deepEqual(s.callIdIndex.get("id2", 0), { toolName: "bash", subKey: "git commit" });
	});

	it("callIdIndex entry expires after CACHE_TTL_TURNS", () => {
		const s = createHarnessState();
		s.callIdIndex.set("id1", { toolName: "read" }, 0);
		assert.equal(s.callIdIndex.get("id1", CACHE_TTL_TURNS - 1)?.toolName, "read");
		assert.equal(s.callIdIndex.get("id1", CACHE_TTL_TURNS), null);
	});

	it("recordNested rolls up under the parent key without resetting the chain", () => {
		const s = createHarnessState();
		s.callCounter.record("A", 0, 0);
		assert.equal(s.callCounter.getConsecutive("A").count, 1);

		s.callCounter.recordNested({ toolName: "A" }, 0);
		s.callCounter.record("A", 0, 1);

		assert.equal(s.callCounter.getConsecutive("A").count, 3);
	});

	it("two parallel sibling nested calls under the same parent both roll up", () => {
		const s = createHarnessState();
		s.callCounter.record("A", 0, 0);
		s.callCounter.recordNested({ toolName: "A" }, 0);
		s.callCounter.recordNested({ toolName: "A" }, 0);
		assert.equal(s.callCounter.getConsecutive("A").count, 3);
	});

	it("interleaved parent roll-up stays visible under the parent key", () => {
		const s = createHarnessState();
		s.callCounter.record("A", 0, 0);
		s.callCounter.record("B", 0, 1);
		s.callCounter.recordNested({ toolName: "A" }, 0);
		assert.equal(
			s.callCounter.getConsecutive("A").count,
			2,
			"nested roll-up under A must not be hidden by B's last-key",
		);
	});

	it("nested roll-up survives an interleaved re-record of the parent", () => {
		const s = createHarnessState();
		s.callCounter.record("A", 0, 0);
		s.callCounter.record("B", 0, 1);
		s.callCounter.recordNested({ toolName: "A" }, 0);
		s.callCounter.record("A", 0, 2);
		assert.equal(
			s.callCounter.getConsecutive("A").count,
			3,
			"nested roll-up is preserved when the parent is re-recorded after B",
		);
	});

	it("recordNested resolves the parent's bash sub-key composite identity", () => {
		const s = createHarnessState();
		s.callCounter.record("bash", 0, 0, "git commit");
		s.callCounter.record("bash", 0, 1, "git commit");
		s.callCounter.recordNested({ toolName: "bash", subKey: "git commit" }, 0);
		assert.equal(
			s.callCounter.getConsecutive("bash", "git commit").count,
			3,
			"nested roll-up targets the parent's stored sub-key entry",
		);
	});

	it("recordNested uses the parent's own sub-key, not the latest same-tool sub-key", () => {
		const s = createHarnessState();
		s.callCounter.record("bash", 0, 0, "git commit");
		s.callCounter.record("bash", 0, 1, "npm test");
		// The nested call cites git commit's id — it must roll up to git commit,
		// not to whichever bash sub-key was recorded last (npm test).
		s.callCounter.recordNested({ toolName: "bash", subKey: "git commit" }, 0);
		assert.equal(
			s.callCounter.getConsecutive("bash", "git commit").count,
			2,
			"roll-up lands on the parent's own sub-key",
		);
		s.callCounter.record("bash", 0, 2, "npm test");
		assert.equal(
			s.callCounter.getConsecutive("bash", "npm test").count,
			1,
			"the sibling sub-key is not inflated by the roll-up",
		);
	});

	it("recordNested does not leak into a different sub-key of the same tool", () => {
		const s = createHarnessState();
		s.callCounter.record("bash", 0, 0, "git status");
		s.callCounter.recordNested({ toolName: "bash", subKey: "git status" }, 0);
		assert.equal(s.callCounter.getConsecutive("bash", "git status").count, 2);
		s.callCounter.record("bash", 0, 1, "npm test");
		assert.equal(
			s.callCounter.getConsecutive("bash", "npm test").count,
			1,
			"a fresh sub-key starts its own chain",
		);
	});

	it("recordNested never creates an entry under the nested tool name", () => {
		const s = createHarnessState();
		s.callCounter.recordNested({ toolName: "nested" }, 0);
		assert.equal(s.callCounter.getConsecutive("nested").count, 0);
	});

	it("recordNested(unmappedParent) is a no-op", () => {
		const s = createHarnessState();
		s.callCounter.recordNested({ toolName: "ghost" }, 0);
		assert.equal(s.callCounter.getConsecutive("ghost").count, 0);
	});

	it("nested errors push under the parent key, not the nested tool name", () => {
		const s = createHarnessState();
		s.errorTracker.push("parent", { turn: 0, toolName: "nested" });
		s.errorTracker.push("parent", { turn: 0, toolName: "nested" });
		assert.equal(s.errorTracker.getLastErrors("parent").length, 2);
		assert.equal(s.errorTracker.getLastErrors("nested").length, 0);
	});

	it("rolled-up nested errors respect MAX_ERRORS_PER_TOOL (3)", () => {
		const s = createHarnessState();
		for (let i = 0; i < 5; i++) {
			s.errorTracker.push("parent", { turn: i, toolName: "nested" });
		}
		assert.equal(s.errorTracker.getLastErrors("parent").length, 3);
	});

	it("turnBoundaryReset clears callIdIndex", () => {
		const s = createHarnessState();
		s.callIdIndex.set("id1", { toolName: "read" }, 0);
		s.callCounter.turnBoundaryReset();
		assert.equal(s.callIdIndex.get("id1", 0), null);
	});

	it("callCounter.reset clears callIdIndex", () => {
		const s = createHarnessState();
		s.callIdIndex.set("id1", { toolName: "read" }, 0);
		s.callCounter.reset();
		assert.equal(s.callIdIndex.get("id1", 0), null);
	});

	it("two instances keep independent callIdIndex and counters", () => {
		const s1 = createHarnessState();
		const s2 = createHarnessState();
		s1.callIdIndex.set("id1", { toolName: "read" }, 0);
		s1.callCounter.record("A", 0, 0);
		assert.equal(s2.callIdIndex.get("id1", 0), null);
		assert.equal(s2.callCounter.getConsecutive("A").count, 0);
	});
});
