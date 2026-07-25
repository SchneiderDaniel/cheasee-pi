// ─── Tests: agent/state-helpers.ts — pushLog + MAX_FULL_LOG + pushTextBlock + pushThinkingBlock ────
// pushLog and MAX_FULL_LOG were relocated from agent/stream.ts.
// pushTextBlock and pushThinkingBlock were extracted from event/adapter.ts
// to consolidate the repeated guard+push pattern.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pushLog, MAX_FULL_LOG, pushTextBlock, pushThinkingBlock } from "../agent/state-helpers.ts";
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
		toolCalls: [],
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		...overrides,
	};
}

// ─── Phase 1: pushLog + MAX_FULL_LOG ───────────────────────────────

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

// ─── Phase 2: pushTextBlock ────────────────────────────────────────

describe("pushTextBlock — guard+push text dedup helper", () => {
	it("first push with non-empty text: pushes trimmed text, sets flag, pushLogs each non-empty line", () => {
		const state = createState();
		pushTextBlock(state, "Hello\n\nWorld");
		assert.equal(state.textPushedThisTurn, true);
		assert.deepEqual(state.textOutputLines, ["Hello\n\nWorld"]);
		assert.deepEqual(state.fullLog, ["Hello", "World"]);
	});

	it("already pushed + existing endsWith incoming: no-op (dedup)", () => {
		const state = createState({ textPushedThisTurn: true, textOutputLines: ["Hello\nWorld"] });
		const beforeLog = state.fullLog.length;
		pushTextBlock(state, "Hello\nWorld");
		assert.equal(state.textOutputLines.length, 1, "no new entry");
		assert.equal(state.fullLog.length, beforeLog, "no pushLog entries added");
	});

	it("already pushed + existing does NOT endWith incoming: appended, pushLogged", () => {
		const state = createState({ textPushedThisTurn: true, textOutputLines: ["Hello"] });
		const beforeLog = state.fullLog.length;
		pushTextBlock(state, "Hello World");
		assert.deepEqual(state.textOutputLines, ["Hello", "Hello World"]);
		assert.equal(state.fullLog.length, beforeLog + 1, "one pushLog entry for single-line text");
		assert.equal(state.fullLog[beforeLog], "Hello World");
	});

	it("empty string text: no-op, flag unchanged", () => {
		const state = createState({ textPushedThisTurn: false });
		pushTextBlock(state, "");
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.textOutputLines.length, 0);
		assert.equal(state.fullLog.length, 0);
	});

	it("whitespace-only text: no-op, flag unchanged", () => {
		const state = createState({ textPushedThisTurn: false });
		pushTextBlock(state, "   \n  ");
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.textOutputLines.length, 0);
		assert.equal(state.fullLog.length, 0);
	});

	it("multi-line text with mixed blank/non-blank lines: only non-blank pushLogged", () => {
		const state = createState();
		pushTextBlock(state, "line1\n\nline2\n\n\nline3");
		assert.deepEqual(state.textOutputLines, ["line1\n\nline2\n\n\nline3"]);
		assert.deepEqual(state.fullLog, ["line1", "line2", "line3"]);
	});

	it("already pushed + subsequent call with different content that doesn't endWith the existing: appended without duplicating existing prefix", () => {
		const state = createState({ textPushedThisTurn: true, textOutputLines: ["abc"] });
		pushTextBlock(state, "def");
		assert.deepEqual(state.textOutputLines, ["abc", "def"]);
		assert.deepEqual(state.fullLog, ["def"]);
	});
});

// ─── Phase 3: pushThinkingBlock ────────────────────────────────────

describe("pushThinkingBlock — guard+push thinking helper", () => {
	it("first push with non-empty thinking: pushed to BOTH output arrays, flag set, each non-empty line pushLogged with 💭 prefix", () => {
		const state = createState();
		pushThinkingBlock(state, "deep\n\nreasoning");
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.deepEqual(state.textOutputLines, ["deep\n\nreasoning"]);
		assert.deepEqual(state.thinkingOutputLines, ["deep\n\nreasoning"]);
		assert.deepEqual(state.fullLog, ["💭 deep", "💭 reasoning"]);
	});

	it("already pushed: no-op when thinkingPushedThisTurn is already set", () => {
		const state = createState({
			thinkingPushedThisTurn: true,
			textOutputLines: ["prev"],
			thinkingOutputLines: ["prev"],
		});
		const beforeLog = state.fullLog.length;
		pushThinkingBlock(state, "new thought");
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.deepEqual(state.textOutputLines, ["prev"], "no new text entry");
		assert.deepEqual(state.thinkingOutputLines, ["prev"], "no new thinking entry");
		assert.equal(state.fullLog.length, beforeLog, "no pushLog entries added");
	});

	it("empty string thinking: no-op, flag unchanged", () => {
		const state = createState({ thinkingPushedThisTurn: false });
		pushThinkingBlock(state, "");
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(state.textOutputLines.length, 0);
		assert.equal(state.thinkingOutputLines.length, 0);
		assert.equal(state.fullLog.length, 0);
	});

	it("whitespace-only thinking: no-op, flag unchanged", () => {
		const state = createState({ thinkingPushedThisTurn: false });
		pushThinkingBlock(state, "   \n  ");
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(state.textOutputLines.length, 0);
		assert.equal(state.thinkingOutputLines.length, 0);
		assert.equal(state.fullLog.length, 0);
	});

	it("multi-line thinking: each non-empty line pushLogged with 💭 prefix, both output arrays capture full text", () => {
		const state = createState();
		pushThinkingBlock(state, "step 1\n\nstep 2\nstep 3");
		assert.deepEqual(state.textOutputLines, ["step 1\n\nstep 2\nstep 3"]);
		assert.deepEqual(state.thinkingOutputLines, ["step 1\n\nstep 2\nstep 3"]);
		assert.deepEqual(state.fullLog, ["💭 step 1", "💭 step 2", "💭 step 3"]);
	});
});
