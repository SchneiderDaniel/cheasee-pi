// ─── Tests: event-adapter.ts — adapters + processNormalizedEvent ──
// Phase 3+4: JSON line adapter, session event adapter, unified processor.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunState } from "../config/types";
import { processNormalizedEvent } from "../event/adapter.ts";

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

// ─── Phase 1: Kind-to-extractor table + dispatcher ──────────────
// Tests for the table-driven normalizer dispatcher (normalizeEvent).

// Split from event-adapter.test.mts (issue #2035 Long File refactor).
describe("processNormalizedEvent", () => {
	it("handles tool_execution_start", () => {
		const state = createState();
		const result = processNormalizedEvent(
			{ kind: "tool_execution_start", toolName: "read" },
			state,
		);
		assert.equal(state.phase, "tool");
		assert.equal(result.flush, true);
	});

	it("handles tool_execution_end", () => {
		const state = createState({ toolCount: 0 });
		const result = processNormalizedEvent(
			{ kind: "tool_execution_end", toolName: "read", isError: false },
			state,
		);
		assert.equal(state.toolCount, 1);
		assert.equal(result.flush, true);
	});

	it("handles thinking_start", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "thinking_start" }, state);
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(result.flush, true);
	});

	it("handles thinking_delta", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "thinking_delta", delta: "step\n" }, state);
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(result.flush, true);
	});

	it("handles thinking_end without prior delta", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "thinking_end" }, state);
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(result.flush, true);
	});

	it("handles text_start", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "text_start" }, state);
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(result.flush, true);
	});

	it("handles text_delta", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "text_delta", delta: "hello\n" }, state);
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(result.flush, true);
	});

	it("handles text_end without prior delta", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "text_end" }, state);
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(result.flush, true);
	});

	it("handles message_end", () => {
		const state = createState();
		const result = processNormalizedEvent(
			{ kind: "message_end", message: { role: "assistant", content: [] } },
			state,
		);
		assert.equal(result.flush, true);
		assert.equal(state.phase, "idle");
	});

	it("handles message_end with budget check", () => {
		const state = createState({ toolCount: 10, maxToolCalls: 10 });
		processNormalizedEvent(
			{ kind: "message_end", message: { role: "assistant", content: [] } },
			state,
		);
		assert.equal(state.budgetExceeded, true);
	});

	it("handles done", () => {
		const state = createState();
		const result = processNormalizedEvent(
			{ kind: "done", message: { content: [{ type: "text", text: "result" }] } },
			state,
		);
		assert.equal(result.flush, true);
		assert.equal(state.textPushedThisTurn, true);
		assert.ok(
			state.textOutputLines.join("\n").includes("result"),
			"textOutputLines should contain done content",
		);
	});

	it("done after streaming: text content captured via endsWith fallback", () => {
		const state = createState();
		// Simulate streaming that only captured partial text
		processNormalizedEvent({ kind: "text_start" }, state);
		processNormalizedEvent({ kind: "text_delta", delta: "partial\n" }, state);
		processNormalizedEvent({ kind: "text_end" }, state);

		// done with full content — should be captured via endsWith fallback
		processNormalizedEvent(
			{
				kind: "done",
				message: { content: [{ type: "text", text: "partial\nfull content with JSON" }] },
			},
			state,
		);
		assert.ok(
			state.textOutputLines.join("\n").includes("full content with JSON"),
			"done content should be appended to textOutputLines",
		);
	});

	it("handles context_info", () => {
		const state = createState();
		const result = processNormalizedEvent(
			{ kind: "context_info", contextTokens: 5000, contextWindow: 10000 },
			state,
		);
		assert.equal(result.flush, true);
		assert.equal(state.contextInfoReceived, true);
	});

	it("returns {flush:false, workingChange:false} for no-op events", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "turn_start" }, state);
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});

	it("returns {flush:false, workingChange:false} for turn_end", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "turn_end" }, state);
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});

	it("returns {flush:false, workingChange:false} for agent_start", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "agent_start" }, state);
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});

	it("returns {flush:false, workingChange:false} for agent_end", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "agent_end" }, state);
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});

	it("returns {flush:false, workingChange:false} for session", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "session" }, state);
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});

	it("processes the full JSON-based streaming chain without duplicates", () => {
		const state = createState();

		// text streaming via normalized events
		processNormalizedEvent({ kind: "text_start" }, state);
		processNormalizedEvent({ kind: "text_delta", delta: "A\nB\n" }, state);
		processNormalizedEvent({ kind: "text_end" }, state);
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.liveText, "");

		// message_end should not push duplicates
		const before = state.fullLog.length;
		processNormalizedEvent(
			{
				kind: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "A\nB" }] },
			},
			state,
		);
		assert.equal(state.fullLog.length, before, "no duplicate push");
	});

	it("processes the full session-based streaming chain without duplicates", () => {
		const state = createState();

		// thinking streaming via normalized events
		processNormalizedEvent({ kind: "thinking_start" }, state);
		processNormalizedEvent({ kind: "thinking_delta", delta: "t1\nt2\n" }, state);
		processNormalizedEvent({ kind: "thinking_end" }, state);
		assert.equal(state.thinkingPushedThisTurn, true);

		// text streaming
		processNormalizedEvent({ kind: "text_start" }, state);
		processNormalizedEvent({ kind: "text_delta", delta: "r1\nr2\n" }, state);
		processNormalizedEvent({ kind: "text_end" }, state);
		assert.equal(state.textPushedThisTurn, true);

		// message_end — both flags set, should be no-op for content
		const before = state.fullLog.length;
		processNormalizedEvent(
			{
				kind: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "r1\nr2" }] },
			},
			state,
		);
		assert.equal(state.fullLog.length, before, "no duplicates");
	});

	it("multi-turn processing works correctly", () => {
		const state = createState();

		// Turn 1
		processNormalizedEvent({ kind: "text_start" }, state);
		processNormalizedEvent({ kind: "text_delta", delta: "A\nB\n" }, state);
		processNormalizedEvent({ kind: "text_end" }, state);
		processNormalizedEvent(
			{
				kind: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "A\nB" }] },
			},
			state,
		);

		// Turn 2
		processNormalizedEvent({ kind: "text_start" }, state);
		processNormalizedEvent({ kind: "text_delta", delta: "C\nD\n" }, state);
		processNormalizedEvent({ kind: "text_end" }, state);
		processNormalizedEvent(
			{
				kind: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "C\nD" }] },
			},
			state,
		);

		assert.equal(state.fullLog.filter((l) => l === "A").length, 1, "'A' once");
		assert.equal(state.fullLog.filter((l) => l === "B").length, 1, "'B' once");
		assert.equal(state.fullLog.filter((l) => l === "C").length, 1, "'C' once");
		assert.equal(state.fullLog.filter((l) => l === "D").length, 1, "'D' once");
	});

	// ── Bug B regression tests: handleMessageEnd text extraction ──

	it("thinking:high model: partial streaming + full message_end content → textOutputLines has full content", () => {
		const state = createState();

		// Simulate thinking:high model: minimal text_delta, then text_end
		processNormalizedEvent({ kind: "text_start" }, state);
		processNormalizedEvent({ kind: "text_delta", delta: "abc" }, state);
		processNormalizedEvent({ kind: "text_end" }, state);
		// After text_end: tiny text pushed, textPushedThisTurn=true
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines.join("\n"), "abc");

		// message_end with full content (much larger)
		const fullContent = "## Test Plan\n\n1. First test\n2. Second test\n3. Edge cases";
		processNormalizedEvent(
			{
				kind: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: fullContent }] },
			},
			state,
		);

		// textOutputLines should now contain the full content, not just "abc"
		const textOnly = state.textOutputLines.join("\n").trim();
		assert.ok(
			textOnly.includes("## Test Plan"),
			"textOnly should contain full message_end content",
		);
		assert.ok(textOnly.includes("First test"), "textOnly should contain full message_end content");
		assert.ok(textOnly.includes("Edge cases"), "textOnly should contain full message_end content");
	});

	it("multi-line text_delta streaming: completed lines captured in textOutputLines", () => {
		const state = createState();

		// Realistic scenario: multi-line text streamed as deltas with newlines.
		// Each completed line ends with \\n and is pushed to fullLog by handleTextDelta.
		// Regression: textOutputLines must capture completed lines too, not just the
		// last partial line at text_end. Without this, extractAgentCommentBody(textOnly)
		// fails to find the JSON comment body and falls through to textOutput fallback.
		processNormalizedEvent({ kind: "text_start" }, state);
		processNormalizedEvent({ kind: "text_delta", delta: "## Research Findings\n\n" }, state);
		processNormalizedEvent(
			{ kind: "text_delta", delta: '{"action":"COMPLETE","commentBody":"## Research\\nDone"}\n' },
			state,
		);
		processNormalizedEvent({ kind: "text_delta", delta: "```" }, state);
		processNormalizedEvent({ kind: "text_end" }, state);

		// textOutputLines must have all completed lines, not just trailing partial
		const textOnly = state.textOutputLines.join("\n").trim();
		assert.ok(
			textOnly.includes('"action":"COMPLETE"'),
			"JSON action field should be in textOutputLines",
		);
		assert.ok(
			textOnly.includes('"commentBody":"## Research\\nDone"'),
			"JSON commentBody should be in textOutputLines",
		);
		assert.ok(
			textOnly.includes("## Research Findings"),
			"markdown heading should be in textOutputLines",
		);
		assert.ok(textOnly.endsWith("```"), "trailing code fence should be in textOutputLines");
	});

	it("no prior streaming: message_end with content → pushed to textOutputLines", () => {
		const state = createState();
		// No text_start/text_end — message_end arrives without streaming
		processNormalizedEvent(
			{
				kind: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
			},
			state,
		);
		assert.ok(state.textPushedThisTurn, "textPushedThisTurn should be true");
		assert.ok(
			state.textOutputLines.join("\n").includes("Final answer"),
			"textOutputLines should contain message_end content",
		);
	});

	it("empty message_end content → no push, no crash", () => {
		const state = createState();
		processNormalizedEvent(
			{
				kind: "message_end",
				message: { role: "assistant", content: [] },
			},
			state,
		);
		assert.equal(state.textOutputLines.length, 0, "no text output pushed");
	});

	it("null message → no crash", () => {
		const state = createState();
		const result = processNormalizedEvent({ kind: "message_end", message: null as any }, state);
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});

	it("dual-block content (thinking at index 0, text at index 1) → only text extracted", () => {
		const state = createState();
		processNormalizedEvent(
			{
				kind: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "deep reasoning" },
						{ type: "text", text: "## Architecture\nClean design" },
					],
				},
			},
			state,
		);
		// Both text and thinking blocks should be captured in textOutputLines
		// so that textOnly has structured JSON from thinking blocks (thinking:high models)
		const textOnly = state.textOutputLines.join("\n").trim();
		assert.ok(textOnly.includes("## Architecture"), "text block content should be captured");
		assert.ok(
			textOnly.includes("deep reasoning"),
			"thinking block content should be in textOutputLines",
		);
	});

	// ── Phase 4: done handler with array content (push helper extraction) ──

	it("done with array content (text + thinking) pushes both and sets both flags", () => {
		const state = createState();
		processNormalizedEvent(
			{
				kind: "done",
				message: {
					content: [
						{ type: "text", text: "## Result\nAll good" },
						{ type: "thinking", thinking: "deep reasoning" },
					],
				},
			},
			state,
		);
		const textOnly = state.textOutputLines.join("\n").trim();
		assert.ok(textOnly.includes("## Result"), "text block content should be in textOutputLines");
		assert.ok(
			textOnly.includes("deep reasoning"),
			"thinking block content should be in textOutputLines",
		);
		const thinkingOnly = state.thinkingOutputLines.join("\n").trim();
		assert.ok(
			thinkingOnly.includes("deep reasoning"),
			"thinking block content should be in thinkingOutputLines",
		);
		assert.equal(state.textPushedThisTurn, true, "textPushedThisTurn should be true");
		assert.equal(state.thinkingPushedThisTurn, true, "thinkingPushedThisTurn should be true");
	});

	it("done with only thinking block (no text) pushes thinking to both output lines", () => {
		const state = createState();
		processNormalizedEvent(
			{
				kind: "done",
				message: {
					content: [{ type: "thinking", thinking: "only thinking content here" }],
				},
			},
			state,
		);
		const textOnly = state.textOutputLines.join("\n").trim();
		assert.ok(
			textOnly.includes("only thinking content here"),
			"thinking-only content should be in textOutputLines",
		);
		const thinkingOnly = state.thinkingOutputLines.join("\n").trim();
		assert.ok(
			thinkingOnly.includes("only thinking content here"),
			"thinking-only content should be in thinkingOutputLines",
		);
		assert.equal(state.thinkingPushedThisTurn, true, "thinkingPushedThisTurn should be true");
		// textPushedThisTurn should remain false since only thinking content was pushed
		assert.equal(
			state.textPushedThisTurn,
			false,
			"textPushedThisTurn should be false (no text block)",
		);
	});
});

// ─── filterStderr — stderr noise filter (Phase 1) ──────────────────
// filterStderr was relocated from agent/stream.ts to event/adapter.ts
