// ─── Tests: agent/state-helpers.ts — pushLog + MAX_FULL_LOG ────────
// pushLog and MAX_FULL_LOG were relocated from agent/stream.ts.
// pushLog appends entries to state.fullLog with bounded FIFO size.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pushLog, MAX_FULL_LOG } from "../agent/state-helpers.ts";
import type { AgentRunState } from "../config/types";

// ─── Helpers ──────────────────────────────────────────────────────

function createState(overrides?: Partial<AgentRunState>): AgentRunState {
	return {
		currentTool: undefined,
		currentToolArgs: undefined,
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		lastToolName: undefined,
		phase: "idle",
		startedAt: Date.now(),
		contextTokens: undefined,
		contextWindow: undefined,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		...overrides,
	};
}

// ─── Phase 2: pushLog + MAX_FULL_LOG ───────────────────────────────

describe("pushLog — bounded log entry queue", () => {
	it("pushLog appends entry to state.fullLog", () => {
		const state = createState();
		pushLog(state, "entry 1");
		assert.equal(state.fullLog.length, 1);
		assert.equal(state.fullLog[0], "entry 1");
	});

	it("pushLog at MAX_FULL_LOG entries: new entry shifts oldest (FIFO)", () => {
		const state = createState();
		// Fill to MAX_FULL_LOG
		for (let i = 0; i < MAX_FULL_LOG; i++) {
			pushLog(state, `entry ${i}`);
		}
		assert.equal(state.fullLog.length, MAX_FULL_LOG);
		assert.equal(state.fullLog[0], "entry 0");
		assert.equal(state.fullLog[MAX_FULL_LOG - 1], `entry ${MAX_FULL_LOG - 1}`);

		// Push one more — should shift oldest
		pushLog(state, "overflow");
		assert.equal(state.fullLog.length, MAX_FULL_LOG);
		assert.equal(state.fullLog[0], "entry 1");
		assert.equal(state.fullLog[MAX_FULL_LOG - 1], "overflow");
	});

	it("pushLog at MAX_FULL_LOG - 1: no shift, len = MAX_FULL_LOG", () => {
		const state = createState();
		for (let i = 0; i < MAX_FULL_LOG - 1; i++) {
			pushLog(state, `entry ${i}`);
		}
		assert.equal(state.fullLog.length, MAX_FULL_LOG - 1);
		pushLog(state, "final");
		assert.equal(state.fullLog.length, MAX_FULL_LOG);
		assert.equal(state.fullLog[0], "entry 0");
		assert.equal(state.fullLog[MAX_FULL_LOG - 1], "final");
	});

	it("pushLog preserves insertion order", () => {
		const state = createState();
		pushLog(state, "first");
		pushLog(state, "second");
		pushLog(state, "third");
		assert.deepEqual(state.fullLog, ["first", "second", "third"]);
	});

	it("pushLog accepts empty-string entry", () => {
		const state = createState();
		pushLog(state, "");
		assert.equal(state.fullLog.length, 1);
		assert.equal(state.fullLog[0], "");
	});

	it("MAX_FULL_LOG exported as number value 500", () => {
		assert.equal(typeof MAX_FULL_LOG, "number");
		assert.equal(MAX_FULL_LOG, 500);
	});
});
