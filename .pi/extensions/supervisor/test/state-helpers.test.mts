// ─── Tests: agent/state-helpers.ts — pushLog + MAX_FULL_LOG + recordToolResult ──
// pushLog and MAX_FULL_LOG were relocated from agent/stream.ts.
// pushLog appends entries to state.fullLog with bounded FIFO size.
// recordToolResult is the circuit breaker per-tool consecutive-failure counter.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pushLog, MAX_FULL_LOG, recordToolResult } from "../agent/state-helpers.ts";
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
		consecutiveToolFailures: new Map(),
		circuitBroken: false,
		circuitBrokenTool: undefined,
		consecutiveFailureThreshold: 3,
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

// ═══════════════════════════════════════════════════════════════════
// Phase 2: recordToolResult — circuit breaker per-tool counter
// ═══════════════════════════════════════════════════════════════════

describe("recordToolResult — per-tool consecutive failure counter", () => {
	it("success resets counter to 0, returns { tripped: false, count: 0 }", () => {
		const state = createState();
		const result = recordToolResult(state, "web_search", false);
		assert.equal(result.tripped, false);
		assert.equal(result.count, 0);
		assert.equal(result.toolName, "web_search");
		assert.equal(state.consecutiveToolFailures.get("web_search"), 0);
		assert.equal(state.circuitBroken, false);
	});

	it("first failure increments counter to 1, returns { tripped: false, count: 1 }", () => {
		const state = createState();
		const result = recordToolResult(state, "web_search", true);
		assert.equal(result.tripped, false);
		assert.equal(result.count, 1);
		assert.equal(result.toolName, "web_search");
		assert.equal(state.consecutiveToolFailures.get("web_search"), 1);
		assert.equal(state.circuitBroken, false);
	});

	it("3 consecutive failures trip the circuit breaker", () => {
		const state = createState();

		const r1 = recordToolResult(state, "web_search", true);
		assert.equal(r1.tripped, false);
		assert.equal(r1.count, 1);
		assert.equal(state.circuitBroken, false);

		const r2 = recordToolResult(state, "web_search", true);
		assert.equal(r2.tripped, false);
		assert.equal(r2.count, 2);
		assert.equal(state.circuitBroken, false);

		const r3 = recordToolResult(state, "web_search", true);
		assert.equal(r3.tripped, true);
		assert.equal(r3.count, 3);
		assert.equal(state.circuitBroken, true);
		assert.equal(state.circuitBrokenTool, "web_search");
	});

	it("4th consecutive failure stays tripped, counter keeps incrementing", () => {
		const state = createState();

		recordToolResult(state, "web_search", true);
		recordToolResult(state, "web_search", true);
		recordToolResult(state, "web_search", true);
		assert.equal(state.circuitBroken, true);

		const r4 = recordToolResult(state, "web_search", true);
		assert.equal(r4.tripped, true);
		assert.equal(r4.count, 4);
		assert.equal(state.consecutiveToolFailures.get("web_search"), 4);
	});

	it("success after 2 failures resets counter to 0 (never tripped)", () => {
		const state = createState();

		recordToolResult(state, "web_search", true);
		recordToolResult(state, "web_search", true);

		const r3 = recordToolResult(state, "web_search", false);
		assert.equal(r3.tripped, false);
		assert.equal(r3.count, 0);
		assert.equal(state.consecutiveToolFailures.get("web_search"), 0);
		assert.equal(state.circuitBroken, false);
	});

	it("per-tool isolation: web_search trips independently of ripgrep_search", () => {
		const state = createState();

		// 3 failures of web_search
		recordToolResult(state, "web_search", true);
		recordToolResult(state, "web_search", true);
		recordToolResult(state, "web_search", true);

		assert.equal(state.circuitBroken, true);
		assert.equal(state.circuitBrokenTool, "web_search");
		assert.equal(state.consecutiveToolFailures.get("web_search"), 3);

		// 1 failure of ripgrep_search — separate counter, not tripped
		const rgResult = recordToolResult(state, "ripgrep_search", true);
		assert.equal(rgResult.tripped, false);
		assert.equal(rgResult.count, 1);
		assert.equal(state.consecutiveToolFailures.get("ripgrep_search"), 1);
		// circuitBroken stays true from web_search
		assert.equal(state.circuitBroken, true);
	});

	it("uses state.consecutiveFailureThreshold when set", () => {
		const state = createState({ consecutiveFailureThreshold: 2 });

		const r1 = recordToolResult(state, "bash", true);
		assert.equal(r1.tripped, false);
		assert.equal(r1.count, 1);

		const r2 = recordToolResult(state, "bash", true);
		assert.equal(r2.tripped, true);
		assert.equal(r2.count, 2);
		assert.equal(state.circuitBroken, true);
		assert.equal(state.circuitBrokenTool, "bash");
	});

	it("falls back to threshold 3 when state.consecutiveFailureThreshold is 0", () => {
		const state = createState({ consecutiveFailureThreshold: 0 });

		recordToolResult(state, "bash", true);
		recordToolResult(state, "bash", true);
		const r3 = recordToolResult(state, "bash", true);
		assert.equal(r3.tripped, true);
		assert.equal(r3.count, 3);
	});

	it("mutates only consecutitiveToolFailures, circuitBroken, circuitBrokenTool — no other fields", () => {
		const state = createState({ toolCount: 5, failedToolCount: 0, tokenCount: 100 });
		const beforeToolCount = state.toolCount;
		const beforeFailedToolCount = state.failedToolCount;
		const beforeTokenCount = state.tokenCount;

		recordToolResult(state, "bash", true);
		assert.equal(state.toolCount, beforeToolCount, "toolCount should not change");
		assert.equal(state.tokenCount, beforeTokenCount, "tokenCount should not change");
		assert.equal(state.failedToolCount, beforeFailedToolCount, "failedToolCount should not change");
	});

	it("handles empty string toolName", () => {
		const state = createState();
		const r1 = recordToolResult(state, "", true);
		assert.equal(r1.count, 1);
		assert.equal(state.consecutiveToolFailures.get(""), 1);

		const r2 = recordToolResult(state, "", true);
		assert.equal(r2.count, 2);

		const r3 = recordToolResult(state, "", true);
		assert.equal(r3.tripped, true);
	});

	it("handles toolName with special characters", () => {
		const state = createState();
		const toolName = "my-tool@v2/special!";
		const r = recordToolResult(state, toolName, true);
		assert.equal(r.count, 1);
		assert.equal(state.consecutiveToolFailures.get(toolName), 1);
	});
});
