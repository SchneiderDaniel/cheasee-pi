// ─── Tests: event-adapter.ts — adapters + processNormalizedEvent ──
// Phase 3+4: JSON line adapter, session event adapter, unified processor.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunState } from "../config/types";
import {
	jsonLineToNormalizedEvent,
	sessionEventToNormalizedEvent,
	processNormalizedEvent,
	filterStderr,
} from "../event/adapter.ts";

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

// ─── Phase 3: jsonLineToNormalizedEvent ───────────────────────────

describe("jsonLineToNormalizedEvent", () => {
	it("converts tool_execution_start", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/x" } }),
		);
		assert.ok(result);
		assert.equal(result!.kind, "tool_execution_start");
		if (result!.kind === "tool_execution_start") {
			assert.equal(result!.toolName, "read");
			assert.deepEqual(result!.args, { path: "/x" });
		}
	});

	it("converts tool_execution_end", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: true }),
		);
		assert.ok(result);
		assert.equal(result!.kind, "tool_execution_end");
		if (result!.kind === "tool_execution_end") {
			assert.equal(result!.toolName, "read");
			assert.equal(result!.isError, true);
		}
	});

	it("converts context_info", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({ type: "context_info", contextTokens: 5000, contextWindow: 10000 }),
		);
		assert.ok(result);
		assert.equal(result!.kind, "context_info");
		if (result!.kind === "context_info") {
			assert.equal(result!.contextTokens, 5000);
			assert.equal(result!.contextWindow, 10000);
		}
	});

	it("converts message_update thinking_start", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({ type: "message_update", delta: { type: "thinking_start" } }),
		);
		assert.ok(result);
		assert.equal(result!.kind, "thinking_start");
	});

	it("converts message_update thinking_delta", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "step" },
			}),
		);
		assert.ok(result);
		assert.equal(result!.kind, "thinking_delta");
		if (result!.kind === "thinking_delta") {
			assert.equal(result!.delta, "step");
		}
	});

	it("converts message_update thinking_end", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({ type: "message_update", delta: { type: "thinking_end" } }),
		);
		assert.ok(result);
		assert.equal(result!.kind, "thinking_end");
	});

	it("converts message_update text_start", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({ type: "message_update", delta: { type: "text_start" } }),
		);
		assert.ok(result);
		assert.equal(result!.kind, "text_start");
	});

	it("converts message_update text_delta", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "hello" },
			}),
		);
		assert.ok(result);
		assert.equal(result!.kind, "text_delta");
		if (result!.kind === "text_delta") {
			assert.equal(result!.delta, "hello");
		}
	});

	it("converts message_update text_end with usage", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
				usage: { totalTokens: 100, input: 40, output: 60 },
			}),
		);
		assert.ok(result);
		assert.equal(result!.kind, "text_end");
		if (result!.kind === "text_end") {
			assert.equal(result!.usage?.totalTokens, 100);
		}
	});

	it("converts message_update text_end without usage", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({ type: "message_update", delta: { type: "text_end" } }),
		);
		assert.ok(result);
		assert.equal(result!.kind, "text_end");
	});

	it("converts message_end", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			}),
		);
		assert.ok(result);
		assert.equal(result!.kind, "message_end");
		if (result!.kind === "message_end") {
			assert.equal(result!.message.role, "assistant");
		}
	});

	it("converts session event", () => {
		const result = jsonLineToNormalizedEvent(JSON.stringify({ type: "session" }));
		assert.ok(result);
		assert.equal(result!.kind, "session");
	});

	it("converts turn_start and turn_end", () => {
		assert.equal(
			jsonLineToNormalizedEvent(JSON.stringify({ type: "turn_start" }))!.kind,
			"turn_start",
		);
		assert.equal(jsonLineToNormalizedEvent(JSON.stringify({ type: "turn_end" }))!.kind, "turn_end");
	});

	it("converts agent_start and agent_end", () => {
		assert.equal(
			jsonLineToNormalizedEvent(JSON.stringify({ type: "agent_start" }))!.kind,
			"agent_start",
		);
		assert.equal(
			jsonLineToNormalizedEvent(JSON.stringify({ type: "agent_end" }))!.kind,
			"agent_end",
		);
	});

	it("converts done at top level", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({
				type: "done",
				message: {
					content: [{ type: "text", text: "final answer" }],
					usage: { input: 10, output: 5 },
				},
			}),
		);
		assert.ok(result);
		assert.equal(result!.kind, "done");
		if (result!.kind === "done") {
			assert.equal(result!.message.content?.[0]?.type, "text");
			assert.equal(result!.message.content?.[0]?.text, "final answer");
			assert.equal(result!.message.usage?.input, 10);
			assert.equal(result!.message.usage?.output, 5);
		}
	});

	it("converts done at top level without usage", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({
				type: "done",
				message: {
					content: [{ type: "text", text: "done" }],
				},
			}),
		);
		assert.ok(result);
		assert.equal(result!.kind, "done");
		if (result!.kind === "done") {
			assert.equal(result!.message.content?.[0]?.text, "done");
		}
	});

	it("converts done at top level with thinking and text content", () => {
		const result = jsonLineToNormalizedEvent(
			JSON.stringify({
				type: "done",
				message: {
					content: [
						{ type: "thinking", thinking: "deep thought" },
						{ type: "text", text: "result" },
					],
				},
			}),
		);
		assert.ok(result);
		assert.equal(result!.kind, "done");
		if (result!.kind === "done") {
			assert.equal(result!.message.content?.length, 2);
		}
	});

	it("returns null for unknown event types", () => {
		const result = jsonLineToNormalizedEvent(JSON.stringify({ type: "unknown_xyz" }));
		assert.equal(result, null);
	});

	it("returns null for empty line", () => {
		assert.equal(jsonLineToNormalizedEvent(""), null);
	});

	it("returns null for invalid JSON", () => {
		assert.equal(jsonLineToNormalizedEvent("{invalid}"), null);
	});
});

// ─── Phase 3: sessionEventToNormalizedEvent ──────────────────────

describe("sessionEventToNormalizedEvent", () => {
	it("converts tool_execution_start", () => {
		const result = sessionEventToNormalizedEvent({
			type: "tool_execution_start",
			toolName: "read",
			args: { path: "/x" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "tool_execution_start");
		if (result!.kind === "tool_execution_start") {
			assert.equal(result!.toolName, "read");
		}
	});

	it("converts tool_execution_end", () => {
		const result = sessionEventToNormalizedEvent({
			type: "tool_execution_end",
			toolName: "read",
			isError: false,
		});
		assert.ok(result);
		assert.equal(result!.kind, "tool_execution_end");
		assert.equal((result as any).isError, false);
	});

	it("converts message_update thinking_start", () => {
		const result = sessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_start" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "thinking_start");
	});

	it("converts message_update thinking_delta", () => {
		const result = sessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "step" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "thinking_delta");
		if (result!.kind === "thinking_delta") {
			assert.equal(result!.delta, "step");
		}
	});

	it("converts message_update thinking_end", () => {
		const result = sessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "thinking_end");
	});

	it("converts message_update text_start", () => {
		const result = sessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_start" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_start");
	});

	it("converts message_update text_delta", () => {
		const result = sessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_delta");
		if (result!.kind === "text_delta") {
			assert.equal(result!.delta, "hello");
		}
	});

	it("converts message_update text_end", () => {
		const result = sessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_end" },
			message: { usage: { totalTokens: 50, input: 20, output: 30 } },
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_end");
		if (result!.kind === "text_end") {
			assert.equal(result!.usage?.totalTokens, 50);
		}
	});

	it("converts message_update done", () => {
		const result = sessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
			},
			message: { content: [{ type: "text", text: "done" }], usage: { input: 10, output: 5 } },
		});
		assert.ok(result);
		assert.equal(result!.kind, "done");
		if (result!.kind === "done") {
			assert.equal(result!.message.content?.[0]?.type, "text");
			assert.equal(result!.message.content?.[0]?.text, "done");
			assert.equal(result!.message.usage?.input, 10);
			assert.equal(result!.message.usage?.output, 5);
		}
	});

	it("converts done at top level", () => {
		const result = sessionEventToNormalizedEvent({
			type: "done",
			message: {
				content: [{ type: "text", text: "final" }],
				usage: { input: 10, output: 5 },
			},
		});
		assert.ok(result);
		assert.equal(result!.kind, "done");
		if (result!.kind === "done") {
			assert.equal(result!.message.content?.[0]?.text, "final");
			assert.equal(result!.message.usage?.input, 10);
		}
	});

	it("converts done at top level without usage", () => {
		const result = sessionEventToNormalizedEvent({
			type: "done",
			message: {
				content: [{ type: "text", text: "done" }],
			},
		});
		assert.ok(result);
		assert.equal(result!.kind, "done");
		if (result!.kind === "done") {
			assert.equal(result!.message.content?.[0]?.text, "done");
		}
	});

	it("converts done at top level with thinking and text", () => {
		const result = sessionEventToNormalizedEvent({
			type: "done",
			message: {
				content: [
					{ type: "thinking", thinking: "thought" },
					{ type: "text", text: "result" },
				],
			},
		});
		assert.ok(result);
		assert.equal(result!.kind, "done");
		if (result!.kind === "done") {
			assert.equal(result!.message.content?.length, 2);
		}
	});

	it("converts message_end", () => {
		const result = sessionEventToNormalizedEvent({
			type: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.ok(result);
		assert.equal(result!.kind, "message_end");
		if (result!.kind === "message_end") {
			assert.equal(result!.message.role, "assistant");
		}
	});

	it("returns null for context_info (handled differently for sessions)", () => {
		const result = sessionEventToNormalizedEvent({ type: "context_info" });
		assert.equal(result, null);
	});

	it("converts turn_start/end and agent_start/end", () => {
		assert.equal(sessionEventToNormalizedEvent({ type: "turn_start" })!.kind, "turn_start");
		assert.equal(sessionEventToNormalizedEvent({ type: "turn_end" })!.kind, "turn_end");
		assert.equal(sessionEventToNormalizedEvent({ type: "agent_start" })!.kind, "agent_start");
		assert.equal(sessionEventToNormalizedEvent({ type: "agent_end" })!.kind, "agent_end");
	});

	it("returns null for unknown event types", () => {
		const result = sessionEventToNormalizedEvent({ type: "unknown_xyz" });
		assert.equal(result, null);
	});
});

// ─── Phase 4: processNormalizedEvent ──────────────────────────────

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
});

// ─── filterStderr — stderr noise filter (Phase 1) ──────────────────
// filterStderr was relocated from agent/stream.ts to event/adapter.ts

describe("filterStderr — stderr noise filter", () => {
	it("normal mixed stderr: lines without filter patterns pass through unchanged", () => {
		const result = filterStderr("line 1\nline 2\nline 3");
		assert.equal(result, "line 1\nline 2\nline 3");
	});

	it("telemetry rule: line starting with context_info JSON removed", () => {
		const result = filterStderr('normal\n{"type":"context_info","t":1}\nnormal');
		assert.equal(result, "normal\nnormal");
	});

	it("empty input: returns empty string", () => {
		assert.equal(filterStderr(""), "");
	});

	it("all lines filtered: returns empty string", () => {
		const result = filterStderr(
			'import { x } from "y"\n  \n\n    at Object.<anonymous> (/x.js:1:2)',
		);
		assert.equal(result, "");
	});

	it("jiti import rule: line starting with 'import ' removed", () => {
		const result = filterStderr('normal\nimport { something } from "module"\nnormal');
		assert.equal(result, "normal\nnormal");
	});

	it("jiti export rule: line starting with 'export ' removed", () => {
		const result = filterStderr("normal\nexport default class\nnormal");
		assert.equal(result, "normal\nnormal");
	});

	it("stack trace rule: line matching /^\\s+at\\s/ removed", () => {
		const result = filterStderr("normal\n    at Function.run (/path/file.js:1:2)\nnormal");
		assert.equal(result, "normal\nnormal");
	});

	it("empty-line rule: blank and whitespace-only lines removed", () => {
		const result = filterStderr("line 1\n  \n\nline 2");
		assert.equal(result, "line 1\nline 2");
	});

	it("no filterable lines: input returned unchanged", () => {
		const result = filterStderr("just\nregular\nlines");
		assert.equal(result, "just\nregular\nlines");
	});

	it("leading/trailing whitespace: .trim() applied to result", () => {
		const result = filterStderr("  \nline 1\n  \n");
		assert.equal(result, "line 1");
	});
});
