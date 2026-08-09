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
