// ─── Tests: session-events.ts ────────────────────────────────────────
// Tests for processSessionEvent, focusing on the done handler
// dedup fix: textPushedThisTurn/thinkingPushedThisTurn flagging.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processSessionEvent } from "../event/session-events.ts";
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

// ─── Phase 1: text_end/thinking_end dedup flag fix ────────────────

describe("text_end and thinking_end — dedup flag fix (Phase 3)", () => {
	it("text_end leaves textPushedThisTurn=false when liveText is empty and no delta was pushed", () => {
		const state = createState();
		state.liveText = "";
		const ev = {
			type: "message_update",
			assistantMessageEvent: { type: "text_end" },
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, false, "empty text_end must not block fallback capture");
		assert.equal(state.liveText, "", "liveText should be cleared");
		assert.equal(state.textOutputLines.length, 0, "no text output (buffer was empty)");
	});

	it("thinking_end leaves thinkingPushedThisTurn=false when liveThinking is empty and no delta was pushed", () => {
		const state = createState();
		state.liveThinking = "";
		const ev = {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end" },
		};
		processSessionEvent(ev, state);
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
		const ev = {
			type: "message_update",
			assistantMessageEvent: { type: "text_end" },
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines[0], "some text");
	});

	it("thinking_end sets thinkingPushedThisTurn=true when liveThinking has content (existing behavior preserved)", () => {
		const state = createState();
		state.liveThinking = "some thinking";
		const ev = {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end" },
		};
		processSessionEvent(ev, state);
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.ok(state.thinkingOutputLines[0]?.includes("some thinking"));
	});

	it("empty buffer text_end + message_end captures fallback content", () => {
		const state = createState();
		// text_end with empty buffer and no prior text_delta
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_end" },
			},
			state,
		);
		assert.equal(state.textPushedThisTurn, false);

		// message_end follows with full content from provider
		processSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "fallback content" }],
				},
			},
			state,
		);
		assert.equal(state.textOutputLines.length, 1, "fallback content captured");
		assert.equal(state.textOutputLines[0], "fallback content");
	});
});

// ─── Phase 2: Full streaming chain — no duplicate output (trigger scenario) ──
// Reproduce exact trigger: text_delta with complete newline-delimited chunks
// empties buffer, delta handler marks content as pushed, and message_end
// does NOT re-push.

describe("full streaming chain — no duplicate output (Phase 2)", () => {
	it('text_delta("Hello\\nWorld\\n") → text_end → message_end does not re-push to fullLog', () => {
		const state = createState();

		// Step 1: text_delta with complete lines — delta handler consumes all
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "Hello\nWorld\n",
				},
			},
			state,
		);
		// After delta: complete lines pushed to fullLog, buffer cleared
		assert.equal(state.liveText, "", "liveText should be empty after consuming newlines");
		assert.equal(
			state.fullLog.filter((l) => l === "Hello").length,
			1,
			"fullLog has 'Hello' once from delta handler",
		);
		assert.equal(
			state.fullLog.filter((l) => l === "World").length,
			1,
			"fullLog has 'World' once from delta handler",
		);

		// Step 2: text_end with empty buffer — flag remains true from delta handler
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_end" },
			},
			state,
		);
		assert.equal(state.textPushedThisTurn, true, "flag set even though buffer was empty");
		// textOutputLines NOT pushed (buffer was empty at text_end)
		assert.equal(state.textOutputLines.length, 0, "no textOutputLines from empty buffer");

		// Step 3: message_end — flag is true, so message_end should NOT re-push
		const fullLogLengthBefore = state.fullLog.length;
		processSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello\nWorld" }],
				},
			},
			state,
		);

		// fullLog length must not increase (no duplicates)
		assert.equal(state.fullLog.length, fullLogLengthBefore, "fullLog did not grow (no duplicates)");
		assert.equal(
			state.fullLog.filter((l) => l === "Hello").length,
			1,
			"'Hello' still exactly once in fullLog",
		);
		assert.equal(
			state.fullLog.filter((l) => l === "World").length,
			1,
			"'World' still exactly once in fullLog",
		);
	});

	it('thinking_delta("Step 1\\nStep 2\\n") → thinking_end → message_end does not re-push to fullLog', () => {
		const state = createState();

		// Step 1: thinking_delta with complete lines
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "Step 1\nStep 2\n",
				},
			},
			state,
		);
		assert.equal(state.liveThinking, "", "liveThinking empty after consuming newlines");
		assert.equal(
			state.fullLog.filter((l) => l.includes("Step 1")).length,
			1,
			"fullLog has 'Step 1' once from delta handler",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("Step 2")).length,
			1,
			"fullLog has 'Step 2' once from delta handler",
		);

		// Step 2: thinking_end with empty buffer — flag remains true from delta handler
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_end" },
			},
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true, "flag set even though buffer was empty");

		// Step 3: message_end — flag is true, should NOT re-push
		const fullLogLengthBefore = state.fullLog.length;
		processSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "Step 1\nStep 2" }],
				},
			},
			state,
		);

		assert.equal(state.fullLog.length, fullLogLengthBefore, "fullLog did not grow (no duplicates)");
	});

	it("mixed text + thinking streaming with complete lines — both flags block message_end", () => {
		const state = createState();

		// Phase: thinking
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_start" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "thought 1\nthought 2\n",
				},
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_end" },
			},
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true);

		// Phase: text
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_start" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "result 1\nresult 2\n",
				},
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_end" },
			},
			state,
		);
		assert.equal(state.textPushedThisTurn, true);

		// Capture fullLog size before message_end
		const fullLogLenBefore = state.fullLog.length;

		// message_end has both — should NOT add anything (both flags set)
		processSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "thought 1\nthought 2" },
						{ type: "text", text: "result 1\nresult 2" },
					],
				},
			},
			state,
		);

		assert.equal(state.fullLog.length, fullLogLenBefore, "no new log entries from message_end");
		assert.equal(
			state.textOutputLines.length,
			0,
			"no text output lines (buffer was empty at text_end)",
		);
		assert.equal(
			state.thinkingOutputLines.length,
			0,
			"no thinking output lines (buffer was empty at thinking_end)",
		);
	});
});

// ─── Phase 2: Budget check at message_end (Phase 1) ────────────────────

describe("message_end — budget check (Phase 1)", () => {
	it("sets budgetExceeded when toolCount >= maxToolCalls", () => {
		const state = createState({
			toolCount: 30,
			maxToolCalls: 30,
		});
		const ev = {
			type: "message_end",
			message: { role: "assistant", content: [] },
		};
		processSessionEvent(ev, state);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason?.includes("30"));
	});

	it("sets budgetExceeded when tokenCount >= agentTokenBudget", () => {
		const state = createState({
			tokenCount: 500000,
			agentTokenBudget: 500000,
		});
		const ev = {
			type: "message_end",
			message: { role: "assistant", content: [] },
		};
		processSessionEvent(ev, state);
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
		const ev = {
			type: "message_end",
			message: { role: "assistant", content: [] },
		};
		processSessionEvent(ev, state);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason);
		assert.ok(state.budgetExceededReason!.includes("35"), "reason should mention tool count");
		assert.ok(state.budgetExceededReason!.includes("600000"), "reason should mention token count");
	});

	it("does NOT set budgetExceeded when maxToolCalls=0 (unlimited) regardless of toolCount", () => {
		const state = createState({
			toolCount: 100,
			maxToolCalls: 0,
		});
		const ev = {
			type: "message_end",
			message: { role: "assistant", content: [] },
		};
		processSessionEvent(ev, state);
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
		const ev = {
			type: "message_end",
			message: { role: "assistant", content: [] },
		};
		processSessionEvent(ev, state);
		assert.equal(state.budgetExceeded, false);
	});

	it("budgetExceeded remains true when already set (idempotent)", () => {
		const state = createState({
			budgetExceeded: true,
			budgetExceededReason: "Previous check",
			toolCount: 30,
			maxToolCalls: 30,
		});
		const ev = {
			type: "message_end",
			message: { role: "assistant", content: [] },
		};
		processSessionEvent(ev, state);
		assert.equal(state.budgetExceeded, true);
		// Reason should still mention "Previous check" or be overwritten — either is fine as long as it's truthy
		assert.ok(state.budgetExceededReason);
	});
});

// ─── Phase 3: fix effect — dedup flags set in done handler ─────────────────

describe("done handler — dedup flag fix", () => {
	it("sets textPushedThisTurn=true and clears liveText when done has text content", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [{ type: "text", text: "hello" }],
			},
		};
		const result = processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, true, "textPushedThisTurn should be true");
		assert.equal(state.liveText, "", "liveText should be cleared");
		assert.equal(state.textOutputLines[0], "hello", "text output should be pushed");
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("sets thinkingPushedThisTurn=true and clears liveThinking when done has thinking content", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [{ type: "thinking", thinking: "deep thought" }],
			},
		};
		const result = processSessionEvent(ev, state);
		assert.equal(state.thinkingPushedThisTurn, true, "thinkingPushedThisTurn should be true");
		assert.equal(state.liveThinking, "", "liveThinking should be cleared");
		assert.ok(
			state.thinkingOutputLines[0]?.includes("deep thought"),
			`thinking output should be pushed, got: ${state.thinkingOutputLines[0]}`,
		);
		assert.equal(result.flush, true);
	});

	it("sets both flags and clears both buffers with mixed text + thinking content", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [
					{ type: "text", text: "hello" },
					{ type: "thinking", thinking: "deep thought" },
				],
			},
		};
		const result = processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(state.liveText, "");
		assert.equal(state.liveThinking, "");
		assert.equal(state.textOutputLines[0], "hello");
		assert.ok(state.thinkingOutputLines[0]?.includes("deep thought"));
	});

	it("does not set flags when content array is empty (no false positive)", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [],
			},
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, false, "should remain false");
		assert.equal(state.thinkingPushedThisTurn, false, "should remain false");
		assert.equal(state.textOutputLines.length, 0);
		assert.equal(state.thinkingOutputLines.length, 0);
	});

	it("does not crash and does not change flags when message is undefined", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: undefined,
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.thinkingPushedThisTurn, false);
	});

	it("updates tokenCount from usage, flags remain false when no content", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				usage: { input: 10, output: 5 },
			},
		};
		processSessionEvent(ev, state);
		assert.equal(state.tokenCount, 15);
		assert.equal(state.textPushedThisTurn, false, "should remain false (no content)");
		assert.equal(state.thinkingPushedThisTurn, false, "should remain false (no content)");
	});

	it("pushes multi-line text correctly and sets flag, clears liveText", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [{ type: "text", text: "line1\nline2\nline3" }],
			},
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.liveText, "");
		assert.equal(state.textOutputLines[0], "line1\nline2\nline3");
		// fullLog should contain 3 log entries (one per line)
		const logEntries = state.fullLog.filter((l) => l === "line1" || l === "line2" || l === "line3");
		assert.equal(logEntries.length, 3);
	});

	it("does not push empty/whitespace-only text, flags unchanged", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [{ type: "text", text: "   " }],
			},
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.textOutputLines.length, 0);
	});

	it("does not push thinking again when thinkingPushedThisTurn is already true from preceding thinking_end", () => {
		const state = createState();
		state.thinkingPushedThisTurn = true; // already pushed by thinking_end
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [{ type: "thinking", thinking: "deep thought" }],
			},
		};
		processSessionEvent(ev, state);
		// thinking should NOT be pushed again
		assert.equal(state.thinkingOutputLines.length, 0, "should not push thinking again");
		assert.equal(state.thinkingPushedThisTurn, true, "flag should stay true");
	});
});

// ─── Phase 2: dedup chain — done then message_end produce no duplicate ─────

describe("dedup chain — done then message_end", () => {
	it("does not duplicate text content when message_end follows done", () => {
		const state = createState();

		// Step 1: done event
		const doneEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [{ type: "text", text: "hello world" }],
			},
		};
		processSessionEvent(doneEv, state);

		// Step 2: message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello world" }],
			},
		};
		processSessionEvent(endEv, state);

		assert.equal(state.textOutputLines.length, 1, "should have exactly 1 text entry");
		assert.equal(state.textOutputLines[0], "hello world");
		const textLinesInLog = state.fullLog.filter(
			(l) => l === "hello world" || l === "hello world (duplicate)",
		);
		// fullLog should have exactly 1 "hello world" entry (no duplicate)
		assert.equal(
			state.fullLog.filter((l) => l === "hello world").length,
			1,
			"fullLog should contain 'hello world' exactly once",
		);
	});

	it("does not duplicate thinking content when message_end follows done", () => {
		const state = createState();

		// Step 1: done event
		const doneEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [{ type: "thinking", thinking: "deep thought" }],
			},
		};
		processSessionEvent(doneEv, state);

		// Step 2: message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "deep thought" }],
			},
		};
		processSessionEvent(endEv, state);

		assert.equal(state.thinkingOutputLines.length, 1, "should have exactly 1 thinking entry");
		// Flags persist through message_end so handleDone can rely on them
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(state.textPushedThisTurn, false);
	});

	it("does not duplicate mixed content when message_end follows done", () => {
		const state = createState();

		// Step 1: done event
		const doneEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: {
				content: [
					{ type: "text", text: "hello" },
					{ type: "thinking", thinking: "deep thought" },
				],
			},
		};
		processSessionEvent(doneEv, state);

		// Step 2: message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "thinking", thinking: "deep thought" },
				],
			},
		};
		processSessionEvent(endEv, state);

		assert.equal(state.textOutputLines.length, 1, "should have exactly 1 text entry");
		assert.equal(state.thinkingOutputLines.length, 1, "should have exactly 1 thinking entry");
	});

	it("message_end without prior done pushes content normally (fallback path works)", () => {
		const state = createState();
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello from message_end" }],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.textOutputLines.length, 1);
		assert.equal(state.textOutputLines[0], "hello from message_end");
	});

	it("message_end skips content push when flags already set (done already flushed)", () => {
		const state = createState();
		// Pre-set flags as if done already pushed
		state.textPushedThisTurn = true;
		state.thinkingPushedThisTurn = true;

		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "should not appear" },
					{ type: "thinking", thinking: "should not appear" },
				],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.textOutputLines.length, 0, "no text should be pushed");
		assert.equal(state.thinkingOutputLines.length, 0, "no thinking should be pushed");
		// Flags persist through message_end for handleDone
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.thinkingPushedThisTurn, true);
	});

	it("message_end does not re-push content already consumed by text_end/thinking_end streaming path", () => {
		const state = createState();
		// Simulate streaming path: text_end already set the flag
		state.textPushedThisTurn = true;
		state.thinkingPushedThisTurn = true;

		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "already streamed" },
					{ type: "thinking", thinking: "already streamed" },
				],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.textOutputLines.length, 0, "no duplicate from streaming path");
		assert.equal(state.thinkingOutputLines.length, 0, "no duplicate from streaming path");
	});
});

// ─── Phase 3: existing behavior preserved (regression) ────────────────────

describe("existing behavior preserved (regression)", () => {
	it("text_end (streaming) followed by message_end — one text entry, flag preserved", () => {
		const state = createState();
		state.liveText = "streamed text";

		// text_end
		const textEndEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_end",
			},
		};
		processSessionEvent(textEndEv, state);
		assert.equal(state.textPushedThisTurn, true, "text_end should set flag");
		assert.equal(state.textOutputLines[0], "streamed text");

		// message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "streamed text" }],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.textOutputLines.length, 1, "no duplicate");
		assert.equal(state.textPushedThisTurn, true, "persists for handleDone");
	});

	it("thinking_end (streaming) followed by message_end — one thinking entry, flag preserved", () => {
		const state = createState();
		state.liveThinking = "streamed thinking";

		// thinking_end
		const thinkingEndEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_end",
			},
		};
		processSessionEvent(thinkingEndEv, state);
		assert.equal(state.thinkingPushedThisTurn, true, "thinking_end should set flag");
		assert.ok(state.thinkingOutputLines[0]?.includes("streamed thinking"));

		// message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "streamed thinking" }],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.thinkingOutputLines.length, 1, "no duplicate");
		assert.equal(state.thinkingPushedThisTurn, true, "persists for handleDone");
	});

	it("message_end with role=toolResult — unchanged behavior", () => {
		const state = createState();
		const endEv = {
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "read_file",
				content: [{ type: "text", text: "file contents here" }],
			},
		};
		processSessionEvent(endEv, state);
		// Should push a log entry for tool result
		const toolLog = state.fullLog.find((l) => l.includes("📋"));
		assert.ok(toolLog, "should have tool result log entry");
		assert.ok(toolLog?.includes("read_file"), "log should mention tool name");
	});

	it("message_end without message object — no crash, returns correct flags", () => {
		const state = createState();
		const endEv = {
			type: "message_end",
			message: undefined,
		};
		const result = processSessionEvent(endEv, state);
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});

	it("text_start still resets textPushedThisTurn to false", () => {
		const state = createState();
		// Pre-set flag true (as if previous content was pushed)
		state.textPushedThisTurn = true;

		const textStartEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_start",
			},
		};
		processSessionEvent(textStartEv, state);
		assert.equal(state.textPushedThisTurn, false, "text_start reset flag");
	});

	it("thinking_start still resets thinkingPushedThisTurn to false", () => {
		const state = createState();
		state.thinkingPushedThisTurn = true;

		const thinkingStartEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_start",
			},
		};
		processSessionEvent(thinkingStartEv, state);
		assert.equal(state.thinkingPushedThisTurn, false, "thinking_start reset flag");
	});
});

// ─── Phase 3: Multi-turn dedup — fullLog grows linearly, not 2× ──────────

describe("multi-turn dedup — fullLog does not accumulate duplicates (Phase 3)", () => {
	it("two back-to-back text turns with complete-line streaming — no duplicates", () => {
		const state = createState();

		// Turn 1
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_start" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "line A\nline B\n",
				},
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_end" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "line A\nline B" }],
				},
			},
			state,
		);

		// Turn 2
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_start" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "line C\nline D\n",
				},
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_end" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "line C\nline D" }],
				},
			},
			state,
		);

		// fullLog should have exactly 4 entries (one per unique line)
		// Each turn's delta handler pushes 2 lines, text_end skips push (buffer empty),
		// message_end skips (flag set). No duplicates.
		assert.equal(state.fullLog.filter((l) => l === "line A").length, 1, "'line A' appears once");
		assert.equal(state.fullLog.filter((l) => l === "line B").length, 1, "'line B' appears once");
		assert.equal(state.fullLog.filter((l) => l === "line C").length, 1, "'line C' appears once");
		assert.equal(state.fullLog.filter((l) => l === "line D").length, 1, "'line D' appears once");
	});

	it("two back-to-back thinking turns with complete-line streaming — no duplicates", () => {
		const state = createState();

		// Turn 1
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_start" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "thought X\nthought Y\n",
				},
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_end" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "thought X\nthought Y" }],
				},
			},
			state,
		);

		// Turn 2
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_start" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "thought Z\nthought W\n",
				},
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_end" },
			},
			state,
		);
		processSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "thought Z\nthought W" }],
				},
			},
			state,
		);

		assert.equal(
			state.fullLog.filter((l) => l.includes("thought X")).length,
			1,
			"'thought X' once",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("thought Y")).length,
			1,
			"'thought Y' once",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("thought Z")).length,
			1,
			"'thought Z' once",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("thought W")).length,
			1,
			"'thought W' once",
		);
	});

	it("ten turns of text streaming — fullLog grows linearly (10×2=20 lines)", () => {
		const state = createState();

		for (let turn = 0; turn < 10; turn++) {
			// Simulate streaming where each turn produces 2 content lines
			processSessionEvent(
				{
					type: "message_update",
					assistantMessageEvent: { type: "text_start" },
				},
				state,
			);
			processSessionEvent(
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: `turn ${turn} line 1\nturn ${turn} line 2\n`,
					},
				},
				state,
			);
			processSessionEvent(
				{
					type: "message_update",
					assistantMessageEvent: { type: "text_end" },
				},
				state,
			);
			processSessionEvent(
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `turn ${turn} line 1\nturn ${turn} line 2` }],
					},
				},
				state,
			);
		}

		// 10 turns × 2 lines each = 20 entries, no duplicates
		assert.equal(state.fullLog.length, 20, "fullLog has exactly 20 entries (10 turns × 2 lines)");
		for (let turn = 0; turn < 10; turn++) {
			assert.equal(
				state.fullLog.filter((l) => l === `turn ${turn} line 1`).length,
				1,
				`turn ${turn} line 1 appears once`,
			);
			assert.equal(
				state.fullLog.filter((l) => l === `turn ${turn} line 2`).length,
				1,
				`turn ${turn} line 2 appears once`,
			);
		}
	});
});
