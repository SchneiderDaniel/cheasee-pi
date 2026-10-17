// ─── Tests: processNormalizedEvent — Phase 1 budget check + Phase 3 dedup fix ──
// Tests for processNormalizedEvent, covering message_end budget check
// and text_end/thinking_end dedup flag fix via NormalizedEvent interface.
// Formerly tested through processJsonLine (agent/stream.ts, now deleted).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonLineToNormalizedEvent, processNormalizedEvent } from "../event/adapter.ts";
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

/** Convert a JSON line to NormalizedEvent then process it. */
function processViaNormalized(
	line: string,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	const normalized = jsonLineToNormalizedEvent(line);
	if (!normalized) return { flush: false, workingChange: false };
	return processNormalizedEvent(normalized, state);
}

// ─── Stream drivers ────────────────────────────────────────────────
// Shared event-stream preludes. Pure drivers (no assertions inside) so each
// test still owns its distinguishing checks and the `message_update` envelope
// lives in exactly one place.

const THINKING_STREAM = { type: "thinking_delta", thinking_delta: "t1\nt2\n" };
const TEXT_STREAM = { type: "text_delta", text_delta: "r1\nr2\n" };

/** Drive a thinking_start → thinking_delta → thinking_end envelope sequence. */
function streamThinking(state: AgentRunState, text = THINKING_STREAM.thinking_delta): void {
	processViaNormalized(
		JSON.stringify({ type: "message_update", delta: { type: "thinking_start" } }),
		state,
	);
	processViaNormalized(
		JSON.stringify({
			type: "message_update",
			delta: { ...THINKING_STREAM, thinking_delta: text },
		}),
		state,
	);
	processViaNormalized(
		JSON.stringify({ type: "message_update", delta: { type: "thinking_end" } }),
		state,
	);
}

/** Drive a text_start → text_delta → text_end envelope sequence. */
function streamText(state: AgentRunState, text = TEXT_STREAM.text_delta): void {
	processViaNormalized(
		JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
		state,
	);
	processViaNormalized(
		JSON.stringify({ type: "message_update", delta: { ...TEXT_STREAM, text_delta: text } }),
		state,
	);
	processViaNormalized(
		JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
		state,
	);
}

/** Invariants shared by the done / message_end "thinking content fallback" tests. */
function assertThinkingFallback(state: AgentRunState): void {
	assert.equal(
		state.thinkingOutputLines.length,
		1,
		"thinking output populated (fallback preserved)",
	);
	assert.equal(
		state.textOutputLines.length,
		1,
		"text output has thinking content (fallback for textOnly)",
	);
	assert.equal(state.textOutputLines[0], "t1\nt2", "textOutputLines has thinking content");
	assert.equal(state.fullLog.filter((l) => l.includes("💭 t1")).length, 1, "thinking in fullLog");
}

// ─── Phase 1: Budget check via message_end ──────────────────────────

// Split from agent-stream.test.mts (issue #2035 Long File refactor).
describe("processNormalizedEvent — multi-turn dedup (Phase 3)", () => {
	it("two turns of complete-line JSON — no duplicates", () => {
		const state = createState();

		// Turn 1
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_start" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "A\nB\n" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "A\nB" }],
				},
			}),
			state,
		);

		// Turn 2
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_start" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "C\nD\n" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "C\nD" }],
				},
			}),
			state,
		);

		assert.equal(state.fullLog.filter((l) => l === "A").length, 1, "'A' once");
		assert.equal(state.fullLog.filter((l) => l === "B").length, 1, "'B' once");
		assert.equal(state.fullLog.filter((l) => l === "C").length, 1, "'C' once");
		assert.equal(state.fullLog.filter((l) => l === "D").length, 1, "'D' once");
	});

	it("ten turns of complete-line JSON — fullLog grows linearly (10×2=20 lines)", () => {
		const state = createState();

		for (let turn = 0; turn < 10; turn++) {
			processViaNormalized(
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_start" },
				}),
				state,
			);
			processViaNormalized(
				JSON.stringify({
					type: "message_update",
					delta: {
						type: "text_delta",
						text_delta: `turn ${turn} A\nturn ${turn} B\n`,
					},
				}),
				state,
			);
			processViaNormalized(
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_end" },
				}),
				state,
			);
			processViaNormalized(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `turn ${turn} A\nturn ${turn} B` }],
					},
				}),
				state,
			);
		}

		assert.equal(state.fullLog.length, 20, "fullLog has 20 entries (10×2)");
		for (let turn = 0; turn < 10; turn++) {
			assert.equal(
				state.fullLog.filter((l) => l === `turn ${turn} A`).length,
				1,
				`turn ${turn} A once`,
			);
			assert.equal(
				state.fullLog.filter((l) => l === `turn ${turn} B`).length,
				1,
				`turn ${turn} B once`,
			);
		}
	});
});

// ─── Phase 2 (cont.): Done event dedup via handleDone ───────────────

describe("processNormalizedEvent — done event dedup (Phase 2)", () => {
	it("thinking + text delta streaming → done with both flags set — no re-push", () => {
		const state = createState();

		streamThinking(state);
		assert.equal(state.thinkingPushedThisTurn, true);

		streamText(state);
		assert.equal(state.textPushedThisTurn, true);

		// Done event — both flags are set, so neither thinking nor text is re-pushed
		const fullLogLenBefore = state.fullLog.length;
		processViaNormalized(
			JSON.stringify({
				type: "done",
				message: {
					content: [
						{ type: "thinking", thinking: "t1\nt2" },
						{ type: "text", text: "r1\nr2" },
					],
				},
			}),
			state,
		);

		assert.equal(
			state.fullLog.length,
			fullLogLenBefore,
			"fullLog unchanged (both flags block re-push)",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("💭 t1")).length,
			1,
			"thinking content NOT re-pushed by done",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("💭 t2")).length,
			1,
			"thinking content NOT re-pushed by done",
		);
		assert.equal(state.fullLog.filter((l) => l === "r1").length, 1, "text NOT re-pushed");
		assert.equal(state.fullLog.filter((l) => l === "r2").length, 1, "text NOT re-pushed");
		assert.equal(state.textOutputLines.length, 2, "text output has 2 streamed lines (r1, r2)");
		assert.equal(
			state.thinkingOutputLines.length,
			0,
			"thinking output not populated (dedup guard)",
		);
	});

	it("thinking delta streaming + no text streaming → done skips thinking, pushes text", () => {
		const state = createState();

		// Thinking streaming only — no text streaming
		streamThinking(state);
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(state.textPushedThisTurn, false);

		// Done event — thinking skipped (flag true), text pushed (flag false)
		const fullLogLenBefore = state.fullLog.length;
		processViaNormalized(
			JSON.stringify({
				type: "done",
				message: {
					content: [
						{ type: "thinking", thinking: "t1\nt2" },
						{ type: "text", text: "Hello World" },
					],
				},
			}),
			state,
		);

		// Thinking NOT re-pushed
		assert.equal(
			state.thinkingOutputLines.length,
			0,
			"thinking output not re-pushed (dedup guard)",
		);
		assert.equal(state.fullLog.length, fullLogLenBefore + 1, "fullLog grows by 1 (text only)");
		assert.equal(
			state.fullLog.filter((l) => l.includes("💭 t1")).length,
			1,
			"thinking NOT re-pushed (already in log from delta)",
		);
		// Text IS pushed (no prior text streaming)
		assert.equal(state.textOutputLines.length, 1, "text output has Hello World");
		assert.equal(state.textOutputLines[0], "Hello World", "text is Hello World");
		assert.equal(
			state.fullLog.filter((l) => l === "Hello World").length,
			1,
			"Hello World appears once in fullLog",
		);
	});

	it("no prior streaming → done with thinking content populates fallback", () => {
		const state = createState();

		// No prior streaming — done with thinking content
		processViaNormalized(
			JSON.stringify({
				type: "done",
				message: {
					content: [{ type: "thinking", thinking: "t1\nt2" }],
				},
			}),
			state,
		);

		// Fallback: thinking pushed to both textOutputLines and thinkingOutputLines
		assertThinkingFallback(state);
	});
});

// ─── Phase 3: Non-streamed fallback preserved ─────────────────────

describe("processNormalizedEvent — non-streamed fallback preserved (Phase 3)", () => {
	it("message_end with thinking content, no prior thinking deltas — fallback works", () => {
		const state = createState();

		// No prior thinking deltas — message_end with thinking content
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "t1\nt2" }],
				},
			}),
			state,
		);

		// Fallback preserved: thinking pushed to textOutputLines and thinkingOutputLines
		assertThinkingFallback(state);
	});

	it("done event with thinking content, no prior thinking deltas — fallback works", () => {
		const state = createState();

		// No prior thinking deltas — done with thinking content
		processViaNormalized(
			JSON.stringify({
				type: "done",
				message: {
					content: [{ type: "thinking", thinking: "t1\nt2" }],
				},
			}),
			state,
		);

		// Fallback preserved: thinking pushed to textOutputLines and thinkingOutputLines
		assertThinkingFallback(state);
	});
});

// ─── Stream helper behavior (extraction guard) ─────────────────────

describe("stream helpers", () => {
	it("streamThinking drives start → delta → end and logs thinking lines once", () => {
		const state = createState();
		streamThinking(state);
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(state.fullLog.filter((l) => l.includes("💭 t1")).length, 1);
		assert.equal(state.fullLog.filter((l) => l.includes("💭 t2")).length, 1);
		assert.equal(state.liveThinking, "");
	});

	it("streamText drives start → delta → end and populates text output lines", () => {
		const state = createState();
		streamText(state);
		assert.equal(state.textPushedThisTurn, true);
		assert.deepEqual(state.textOutputLines, ["r1", "r2"]);
		assert.equal(state.liveText, "");
	});

	it("custom thinking text threads through the driver", () => {
		const state = createState();
		streamThinking(state, "z\n");
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(state.fullLog.filter((l) => l.includes("💭 z")).length, 1);
		assert.equal(state.fullLog.filter((l) => l.includes("💭 t1")).length, 0);
	});

	it("custom text threads through the driver", () => {
		const state = createState();
		streamText(state, "only\n");
		assert.equal(state.textPushedThisTurn, true);
		assert.deepEqual(state.textOutputLines, ["only"]);
	});

	it("drivers do not cross phases", () => {
		const thinkingOnly = createState();
		streamThinking(thinkingOnly);
		assert.equal(thinkingOnly.textPushedThisTurn, false);
		assert.deepEqual(thinkingOnly.textOutputLines, []);

		const textOnly = createState();
		streamText(textOnly);
		assert.equal(textOnly.thinkingPushedThisTurn, false);
		assert.equal(textOnly.fullLog.filter((l) => l.includes("💭")).length, 0);
	});

	it("assertThinkingFallback accepts the done-with-thinking fallback state", () => {
		const state = createState();
		processViaNormalized(
			JSON.stringify({
				type: "done",
				message: { content: [{ type: "thinking", thinking: "t1\nt2" }] },
			}),
			state,
		);
		assertThinkingFallback(state);
	});

	it("assertThinkingFallback rejects a state missing the fallback invariants", () => {
		assert.throws(() => assertThinkingFallback(createState()), assert.AssertionError);
	});
});
