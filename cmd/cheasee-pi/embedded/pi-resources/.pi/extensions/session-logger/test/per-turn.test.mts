/**
 * Tests for per-turn.ts — extracted flushTurn() shared function
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/per-turn.test.mts
 *
 * These tests validate the extracted flushTurn function works correctly
 * on a PerTurnState object, independent of its consumers.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createPerTurnState, flushTurn } from "../per-turn.ts";

// ---------------------------------------------------------------------------
// flushTurn() — extracted shared function unit tests
// ---------------------------------------------------------------------------

describe("flushTurn() — extracted shared function", () => {
	it("pushes entry and resets accumulators when turnIndex >= 0 with non-zero values", () => {
		const state = createPerTurnState();
		state.currentTurnIndex = 0;
		state.currentTurnTokens = 100;
		state.currentTurnCost = 0.005;
		state.currentTurnToolCount = 3;
		state.currentTurnErrorCount = 1;

		flushTurn(state);

		assert.strictEqual(state.perTurnTokens.length, 1);
		assert.deepStrictEqual(state.perTurnTokens[0], {
			turnIndex: 0,
			tokens: 100,
			cost: 0.005,
			toolCount: 3,
			errorCount: 1,
		});
		assert.strictEqual(state.currentTurnTokens, 0);
		assert.strictEqual(state.currentTurnCost, 0);
		assert.strictEqual(state.currentTurnToolCount, 0);
		assert.strictEqual(state.currentTurnErrorCount, 0);
		// currentTurnIndex is NOT reset by flushTurn
		assert.strictEqual(state.currentTurnIndex, 0);
	});

	it("does not push entry when turnIndex is -1 but still resets accumulators", () => {
		const state = createPerTurnState();
		state.currentTurnIndex = -1;
		state.currentTurnTokens = 100;
		state.currentTurnCost = 0.005;
		state.currentTurnToolCount = 2;
		state.currentTurnErrorCount = 1;

		flushTurn(state);

		assert.strictEqual(state.perTurnTokens.length, 0);
		assert.strictEqual(state.currentTurnTokens, 0);
		assert.strictEqual(state.currentTurnCost, 0);
		assert.strictEqual(state.currentTurnToolCount, 0);
		assert.strictEqual(state.currentTurnErrorCount, 0);
	});

	it("pushes entry with zeros when turnIndex >= 0 but all accumulators are zero", () => {
		const state = createPerTurnState();
		state.currentTurnIndex = 0;

		flushTurn(state);

		assert.strictEqual(state.perTurnTokens.length, 1);
		assert.deepStrictEqual(state.perTurnTokens[0], {
			turnIndex: 0,
			tokens: 0,
			cost: 0,
			toolCount: 0,
			errorCount: 0,
		});
		assert.strictEqual(state.currentTurnTokens, 0);
		assert.strictEqual(state.currentTurnCost, 0);
		assert.strictEqual(state.currentTurnToolCount, 0);
		assert.strictEqual(state.currentTurnErrorCount, 0);
	});

	it("two consecutive calls: first pushes entry then resets, second pushes all-zero entry", () => {
		const state = createPerTurnState();
		state.currentTurnIndex = 0;
		state.currentTurnTokens = 200;
		state.currentTurnCost = 0.01;
		state.currentTurnToolCount = 5;
		state.currentTurnErrorCount = 2;

		flushTurn(state);
		assert.strictEqual(state.perTurnTokens.length, 1);
		assert.strictEqual(state.currentTurnTokens, 0);

		flushTurn(state);
		assert.strictEqual(state.perTurnTokens.length, 2);
		assert.deepStrictEqual(state.perTurnTokens[1], {
			turnIndex: 0,
			tokens: 0,
			cost: 0,
			toolCount: 0,
			errorCount: 0,
		});
	});

	it("different turn indices across calls produce correct entries", () => {
		const state = createPerTurnState();

		state.currentTurnIndex = 0;
		state.currentTurnTokens = 150;
		flushTurn(state);

		state.currentTurnIndex = 1;
		state.currentTurnTokens = 250;
		flushTurn(state);

		state.currentTurnIndex = 2;
		state.currentTurnTokens = 350;
		flushTurn(state);

		assert.strictEqual(state.perTurnTokens.length, 3);
		assert.strictEqual(state.perTurnTokens[0].turnIndex, 0);
		assert.strictEqual(state.perTurnTokens[0].tokens, 150);
		assert.strictEqual(state.perTurnTokens[1].turnIndex, 1);
		assert.strictEqual(state.perTurnTokens[1].tokens, 250);
		assert.strictEqual(state.perTurnTokens[2].turnIndex, 2);
		assert.strictEqual(state.perTurnTokens[2].tokens, 350);
	});

	it("perTurnTokens preserves previously pushed entries across calls (no data loss)", () => {
		const state = createPerTurnState();

		state.currentTurnIndex = 0;
		state.currentTurnTokens = 100;
		flushTurn(state);

		state.currentTurnIndex = 1;
		state.currentTurnTokens = 200;
		flushTurn(state);

		assert.strictEqual(state.perTurnTokens.length, 2);
		assert.deepStrictEqual(state.perTurnTokens[0], {
			turnIndex: 0,
			tokens: 100,
			cost: 0,
			toolCount: 0,
			errorCount: 0,
		});
		assert.deepStrictEqual(state.perTurnTokens[1], {
			turnIndex: 1,
			tokens: 200,
			cost: 0,
			toolCount: 0,
			errorCount: 0,
		});
	});

	it("flushTurn does not affect turnIndex (caller manages it)", () => {
		const state = createPerTurnState();
		state.currentTurnIndex = 42;
		state.currentTurnTokens = 99;

		flushTurn(state);

		assert.strictEqual(state.currentTurnIndex, 42, "flushTurn should not reset turnIndex");
	});
});
