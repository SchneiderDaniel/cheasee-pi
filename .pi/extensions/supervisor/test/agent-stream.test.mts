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

// ─── Phase 1: Budget check via message_end ──────────────────────────

describe("processNormalizedEvent — budget check at message_end (Phase 1)", () => {
	it("sets budgetExceeded when toolCount >= maxToolCalls", () => {
		const state = createState({ toolCount: 30, maxToolCalls: 30 });
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason?.includes("30"));
	});

	it("sets budgetExceeded when tokenCount >= agentTokenBudget", () => {
		const state = createState({ tokenCount: 500000, agentTokenBudget: 500000 });
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason?.includes("500000"));
	});

	it("sets budgetExceeded and reason covers both when both limits exceeded", () => {
		const state = createState({
			toolCount: 35,
			maxToolCalls: 30,
			tokenCount: 600000,
			agentTokenBudget: 500000,
		});
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason);
		assert.ok(state.budgetExceededReason!.includes("35"));
		assert.ok(state.budgetExceededReason!.includes("600000"));
	});

	it("does NOT set budgetExceeded when maxToolCalls=0 (unlimited) regardless of toolCount", () => {
		const state = createState({ toolCount: 100, maxToolCalls: 0 });
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, false);
		assert.equal(state.budgetExceededReason, undefined);
	});

	it("does NOT set budgetExceeded when toolCount < maxToolCalls and tokenCount < agentTokenBudget", () => {
		const state = createState({
			toolCount: 15,
			maxToolCalls: 30,
			tokenCount: 200000,
			agentTokenBudget: 500000,
		});
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, false);
	});

	it("budgetExceeded remains true when already set (idempotent)", () => {
		const state = createState({
			budgetExceeded: true,
			budgetExceededReason: "Previous check",
			toolCount: 30,
			maxToolCalls: 30,
		});
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason);
	});
});

// ─── Phase 3: Dedup flag fix via JSON line text_end/thinking_end ────

describe("processNormalizedEvent — dedup flag fix (Phase 3)", () => {
	it("text_end leaves textPushedThisTurn=false when liveText is empty and no delta was pushed", () => {
		const state = createState();
		state.liveText = "";
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		assert.equal(state.textPushedThisTurn, false, "empty text_end must not block fallback capture");
		assert.equal(state.liveText, "", "liveText should be cleared");
	});

	it("thinking_end leaves thinkingPushedThisTurn=false when liveThinking is empty and no delta was pushed", () => {
		const state = createState();
		state.liveThinking = "";
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(
			state.thinkingPushedThisTurn,
			false,
			"empty thinking_end must not block fallback capture",
		);
		assert.equal(state.liveThinking, "", "liveThinking should be cleared");
	});

	it("text_end sets textPushedThisTurn=true when liveText has content (existing behavior preserved)", () => {
		const state = createState();
		state.liveText = "some text";
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines[0], "some text");
	});

	it("thinking_end sets thinkingPushedThisTurn=true when liveThinking has content (existing behavior preserved)", () => {
		const state = createState();
		state.liveThinking = "some thinking";
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true);
	});
});

// ─── Phase 2: Full streaming chain via JSON line — no duplicate output ─────

describe("processNormalizedEvent — full streaming chain no duplicate (Phase 2)", () => {
	it('text_delta("Hello\\nWorld\\n") → text_end → message_end re-pushes when text_end had empty buffer', () => {
		const state = createState();

		// Step 1: text_delta with complete lines via JSON
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "Hello\nWorld\n" },
			}),
			state,
		);
		assert.equal(state.liveText, "", "liveText empty after consuming newlines");
		assert.equal(state.fullLog.filter((l) => l === "Hello").length, 1, "fullLog has 'Hello' once");
		assert.equal(state.fullLog.filter((l) => l === "World").length, 1, "fullLog has 'World' once");

		// Step 2: text_end — buffer empty, flag stays true (set during delta)
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		assert.equal(
			state.textPushedThisTurn,
			true,
			"flag was set during delta (when lines were pushed)",
		);

		// Step 3: message_end with full content — flag is true, so guard blocks re-push
		const fullLogLenBefore = state.fullLog.length;
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello\nWorld" }],
				},
			}),
			state,
		);

		// message_end re-pushes because textPushedThisTurn was false
		// (handleTextEnd only sets flag when liveText had content)
		assert.equal(state.fullLog.length, fullLogLenBefore, "fullLog did not grow (text dedup works)");
		assert.equal(state.fullLog.filter((l) => l === "Hello").length, 1, "'Hello' still once");
		assert.equal(state.fullLog.filter((l) => l === "World").length, 1, "'World' still once");
	});

	it('thinking_delta("Step 1\\nStep 2\\n") → thinking_end → message_end dedup guard (handleMessageEnd respects thinkingPushedThisTurn)', () => {
		const state = createState();

		// Step 1: thinking_delta with complete lines
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "Step 1\nStep 2\n" },
			}),
			state,
		);
		assert.equal(state.liveThinking, "", "liveThinking empty after consuming newlines");
		assert.equal(
			state.fullLog.filter((l) => l.includes("Step 1")).length,
			1,
			"fullLog has 'Step 1' once",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("Step 2")).length,
			1,
			"fullLog has 'Step 2' once",
		);

		// Step 2: thinking_end — buffer empty, flag stays true (set during delta)
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true, "flag was set during delta");

		// Step 3: message_end — thinking content skipped because flag is set (dedup guard)
		const fullLogLenBefore = state.fullLog.length;
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "Step 1\nStep 2" }],
				},
			}),
			state,
		);

		// message_end respects thinkingPushedThisTurn flag — no re-push
		assert.equal(
			state.fullLog.length,
			fullLogLenBefore,
			"fullLog unchanged (dedup guard prevents re-push)",
		);
	});

	it("mixed text + thinking via JSON — both blocked by dedup flags", () => {
		const state = createState();

		// Thinking phase: start → delta → end
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_start" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "t1\nt2\n" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true);

		// Text phase: start → delta → end
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
				delta: { type: "text_delta", text_delta: "r1\nr2\n" },
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
		assert.equal(state.textPushedThisTurn, true);

		// message_end — both flags are set, so neither thinking nor text is re-pushed
		const fullLogLenBefore = state.fullLog.length;
		processViaNormalized(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "t1\nt2" },
						{ type: "text", text: "r1\nr2" },
					],
				},
			}),
			state,
		);

		// No re-pushes because both flags are set (dedup guards in handleMessageEnd)
		assert.equal(
			state.fullLog.length,
			fullLogLenBefore,
			"fullLog unchanged (both flags block re-push)",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("💭 t1")).length,
			1,
			"thinking content NOT re-pushed by message_end",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("💭 t2")).length,
			1,
			"thinking content NOT re-pushed by message_end",
		);
		// Text not re-pushed because textPushedThisTurn is true
		assert.equal(state.fullLog.filter((l) => l === "r1").length, 1, "text NOT re-pushed");
		assert.equal(state.fullLog.filter((l) => l === "r2").length, 1, "text NOT re-pushed");
		assert.equal(state.textOutputLines.length, 2, "text output has 2 streamed lines (r1, r2), no duplicates from message_end");
		// thinkingOutputLines NOT populated because thinkingPushedThisTurn is true
		assert.equal(
			state.thinkingOutputLines.length,
			0,
			"thinking output not populated (dedup guard)",
		);
	});
});

// ─── Phase 3: Multi-turn dedup via JSON line — fullLog grows linearly ─────

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

		// Thinking phase: start → delta → end
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_start" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "t1\nt2\n" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true);

		// Text phase: start → delta → end
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
				delta: { type: "text_delta", text_delta: "r1\nr2\n" },
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
		assert.equal(
			state.textOutputLines.length,
			2,
			"text output has 2 streamed lines (r1, r2)",
		);
		assert.equal(
			state.thinkingOutputLines.length,
			0,
			"thinking output not populated (dedup guard)",
		);
	});

	it("thinking delta streaming + no text streaming → done skips thinking, pushes text", () => {
		const state = createState();

		// Thinking streaming only — no text streaming
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_start" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "t1\nt2\n" },
			}),
			state,
		);
		processViaNormalized(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
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
		assert.equal(
			state.fullLog.length,
			fullLogLenBefore + 1,
			"fullLog grows by 1 (text only)",
		);
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
		assert.equal(
			state.fullLog.filter((l) => l.includes("💭 t1")).length,
			1,
			"thinking in fullLog",
		);
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
		assert.equal(
			state.fullLog.filter((l) => l.includes("💭 t1")).length,
			1,
			"thinking in fullLog",
		);
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
		assert.equal(
			state.fullLog.filter((l) => l.includes("💭 t1")).length,
			1,
			"thinking in fullLog",
		);
	});
});
