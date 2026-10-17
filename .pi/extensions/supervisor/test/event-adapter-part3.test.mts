// ─── Tests: event-adapter.ts — adapters + processNormalizedEvent ──
// Phase 3+4: JSON line adapter, session event adapter, unified processor.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunState } from "../config/types";
import {
	normalizeEvent,
	jsonLineToNormalizedEvent,
	processNormalizedEvent,
	filterStderr,
	agentSessionEventToNormalizedEvent,
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

// ─── Phase 3: agentSessionEventToNormalizedEvent (in-process adapter) ──
// Tests for the SDK AgentSessionEvent → NormalizedEvent mapper.
// Phase 3 from test plan: 15 entity tests for all event variants.

describe("agentSessionEventToNormalizedEvent — in-process event mapper", () => {
	it("maps tool_execution_start with toolName and args", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "tool_execution_start",
			toolName: "read",
			args: { path: "/tmp/x.ts" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "tool_execution_start");
		if (result!.kind === "tool_execution_start") {
			assert.equal(result!.toolName, "read");
			assert.deepEqual(result!.args, { path: "/tmp/x.ts" });
		}
	});

	it("maps tool_execution_end with toolName and isError", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "tool_execution_end",
			toolName: "edit",
			isError: true,
		});
		assert.ok(result);
		assert.equal(result!.kind, "tool_execution_end");
		if (result!.kind === "tool_execution_end") {
			assert.equal(result!.toolName, "edit");
			assert.equal(result!.isError, true);
		}
	});

	it("maps message_update with assistantMessageEvent.type=text_delta", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello world" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_delta");
		if (result!.kind === "text_delta") {
			assert.equal(result!.delta, "hello world");
		}
	});

	it("maps message_update with assistantMessageEvent.type=thinking_delta", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "step by step" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "thinking_delta");
		if (result!.kind === "thinking_delta") {
			assert.equal(result!.delta, "step by step");
		}
	});

	it("maps message_update with assistantMessageEvent.type=text_start", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_start" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_start");
	});

	it("maps message_update with assistantMessageEvent.type=thinking_start", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_start" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "thinking_start");
	});

	it("maps message_update with assistantMessageEvent.type=text_end + usage", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "text_end",
				partial: { usage: { totalTokens: 100, input: 40, output: 60 } },
			},
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_end");
		if (result!.kind === "text_end") {
			assert.equal(result!.usage?.totalTokens, 100);
			assert.equal(result!.usage?.input, 40);
			assert.equal(result!.usage?.output, 60);
		}
	});

	it("maps message_update with assistantMessageEvent.type=thinking_end", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "thinking_end");
	});

	it("maps message_end with message object", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		});
		assert.ok(result);
		assert.equal(result!.kind, "message_end");
		if (result!.kind === "message_end") {
			assert.equal(result!.message.role, "assistant");
		}
	});

	it("maps turn_start", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "turn_start" });
		assert.ok(result);
		assert.equal(result!.kind, "turn_start");
	});

	it("maps turn_end", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "turn_end" });
		assert.ok(result);
		assert.equal(result!.kind, "turn_end");
	});

	it("maps agent_start", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "agent_start" });
		assert.ok(result);
		assert.equal(result!.kind, "agent_start");
	});

	it("maps agent_end", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "agent_end" });
		assert.ok(result);
		assert.equal(result!.kind, "agent_end");
	});

	it("returns null for queue_update", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "queue_update" });
		assert.equal(result, null);
	});

	it("returns null for compaction_start", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "compaction_start" });
		assert.equal(result, null);
	});

	it("returns null for compaction_end", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "compaction_end" });
		assert.equal(result, null);
	});

	it("returns null for null/undefined input", () => {
		assert.equal(agentSessionEventToNormalizedEvent(null), null);
		assert.equal(agentSessionEventToNormalizedEvent(undefined), null);
	});

	it("returns null for empty object (no type field)", () => {
		const result = agentSessionEventToNormalizedEvent({});
		assert.equal(result, null);
	});

	it("returns null for unknown event type", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "unknown_event_xyz" });
		assert.equal(result, null);
	});

	it("returns null for message_update without assistantMessageEvent", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "message_update" });
		assert.equal(result, null);
	});

	it("returns null for message_update with unknown sub-type", () => {
		const result = agentSessionEventToNormalizedEvent({
			type: "message_update",
			assistantMessageEvent: { type: "unknown_sub_type" },
		});
		assert.equal(result, null);
	});

	it("tool_execution_start with no toolName defaults to 'tool'", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "tool_execution_start" });
		assert.ok(result);
		if (result!.kind === "tool_execution_start") {
			assert.equal(result!.toolName, "tool");
		}
	});

	it("tool_execution_end with no isError defaults to false", () => {
		const result = agentSessionEventToNormalizedEvent({ type: "tool_execution_end" });
		assert.ok(result);
		if (result!.kind === "tool_execution_end") {
			assert.equal(result!.isError, false);
		}
	});
});

// ─── Nested calls (ctx.executeTool / parentToolCallId) ───────────

describe("nested tool calls — normalization carries parentToolCallId", () => {
	it("normalizeEvent extracts parentToolCallId on tool_execution_start", () => {
		const ev = normalizeEvent("json", {
			type: "tool_execution_start",
			toolName: "read",
			args: { path: "a.ts" },
			parentToolCallId: "call-1",
		});
		assert.ok(ev);
		if (ev!.kind === "tool_execution_start") {
			assert.equal(ev!.parentToolCallId, "call-1");
		}
	});

	it("normalizeEvent extracts parentToolCallId on tool_execution_end", () => {
		const ev = normalizeEvent("json", {
			type: "tool_execution_end",
			toolName: "read",
			isError: true,
			parentToolCallId: "call-2",
		});
		assert.ok(ev);
		if (ev!.kind === "tool_execution_end") {
			assert.equal(ev!.parentToolCallId, "call-2");
			assert.equal(ev!.isError, true);
		}
	});

	it("parentToolCallId absent → undefined (top-level)", () => {
		const ev = normalizeEvent("json", { type: "tool_execution_end", toolName: "bash" });
		assert.ok(ev);
		if (ev!.kind === "tool_execution_end") {
			assert.equal(ev!.parentToolCallId, undefined);
		}
	});

	it("jsonLineToNormalizedEvent carries parentToolCallId", () => {
		const line = JSON.stringify({
			type: "tool_execution_end",
			toolName: "grep",
			parentToolCallId: "p-1",
		});
		const ev = jsonLineToNormalizedEvent(line);
		assert.ok(ev && ev.kind === "tool_execution_end");
		if (ev!.kind === "tool_execution_end") assert.equal(ev!.parentToolCallId, "p-1");
	});

	it("agentSessionEventToNormalizedEvent carries parentToolCallId on start/end", () => {
		const start = agentSessionEventToNormalizedEvent({
			type: "tool_execution_start",
			toolName: "edit",
			args: {},
			parentToolCallId: "n-1",
		});
		assert.ok(start && start.kind === "tool_execution_start");
		if (start!.kind === "tool_execution_start") assert.equal(start!.parentToolCallId, "n-1");

		const end = agentSessionEventToNormalizedEvent({
			type: "tool_execution_end",
			toolName: "edit",
			isError: false,
			parentToolCallId: "n-1",
		});
		assert.ok(end && end.kind === "tool_execution_end");
		if (end!.kind === "tool_execution_end") assert.equal(end!.parentToolCallId, "n-1");
	});
});

describe("nested tool calls — state capture", () => {
	it("nested end appends to nestedCalls without touching toolCount/failedToolCount", () => {
		const state = createState();
		processNormalizedEvent(
			{ kind: "tool_execution_end", toolName: "read", isError: false, parentToolCallId: "p" },
			state,
		);
		assert.deepEqual(state.nestedCalls, [{ name: "read", status: "ok" }]);
		assert.equal(state.toolCount, 0);
		assert.equal(state.failedToolCount ?? 0, 0);
	});

	it("nested error increments nestedErrorCount and records status error", () => {
		const state = createState();
		processNormalizedEvent(
			{ kind: "tool_execution_end", toolName: "bash", isError: true, parentToolCallId: "p" },
			state,
		);
		assert.deepEqual(state.nestedCalls, [{ name: "bash", status: "error" }]);
		assert.equal(state.nestedErrorCount, 1);
		assert.equal(state.failedToolCount ?? 0, 0);
	});

	it("top-level end still counts toward toolCount/failedToolCount", () => {
		const state = createState();
		processNormalizedEvent({ kind: "tool_execution_end", toolName: "bash", isError: true }, state);
		assert.equal(state.toolCount, 1);
		assert.equal(state.failedToolCount, 1);
		assert.equal(state.nestedCalls, undefined);
		assert.equal(state.nestedErrorCount, undefined);
	});

	it("nested start does not enter the top-level tool/phase stream", () => {
		const state = createState();
		const result = processNormalizedEvent(
			{
				kind: "tool_execution_start",
				toolName: "read",
				args: {},
				parentToolCallId: "p",
			},
			state,
		);
		assert.equal(state.phase, "idle");
		assert.equal(state.currentTool, undefined);
		assert.equal(state.toolCalls.length, 0);
		assert.equal(state.fullLog.length, 0);
		assert.equal(result.flush, false);
	});

	it("boundary: MAX_NESTED_CALLS stored, the next sets nestedTruncated and is dropped", () => {
		const state = createState();
		for (let i = 0; i < 30; i++) {
			processNormalizedEvent(
				{ kind: "tool_execution_end", toolName: `t${i}`, isError: false, parentToolCallId: "p" },
				state,
			);
		}
		assert.equal(state.nestedCalls!.length, 30);
		assert.ok(!state.nestedTruncated);

		processNormalizedEvent(
			{ kind: "tool_execution_end", toolName: "overflow", isError: false, parentToolCallId: "p" },
			state,
		);
		assert.equal(state.nestedCalls!.length, 30);
		assert.equal(state.nestedTruncated, true);
	});

	it("dropped-error boundary: errored end past the cap counts, records no entry", () => {
		const state = createState();
		for (let i = 0; i < 30; i++) {
			processNormalizedEvent(
				{ kind: "tool_execution_end", toolName: `t${i}`, isError: false, parentToolCallId: "p" },
				state,
			);
		}
		processNormalizedEvent(
			{ kind: "tool_execution_end", toolName: "boom", isError: true, parentToolCallId: "p" },
			state,
		);
		assert.equal(state.nestedCalls!.length, 30);
		assert.equal(state.nestedTruncated, true);
		assert.equal(state.nestedErrorCount, 1);
		assert.ok(
			state.nestedCalls!.every((c) => c.status === "ok"),
			"the errored call was dropped, so no recorded entry is an error",
		);
	});

	it("zero nested ends → nestedCalls untouched", () => {
		const state = createState();
		assert.equal(state.nestedCalls, undefined);
		assert.equal(state.nestedErrorCount, undefined);
	});
});
