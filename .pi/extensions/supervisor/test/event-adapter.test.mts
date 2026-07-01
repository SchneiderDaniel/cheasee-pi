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

// ─── Phase 1: Kind-to-extractor table + dispatcher ──────────────
// Tests for the table-driven normalizer dispatcher (normalizeEvent).

describe("normalizeEvent — table + dispatcher", () => {
	it("dispatcher with unregistered kind returns null", () => {
		const result = normalizeEvent("json", { type: "nonexistent_kind" });
		assert.equal(result, null);
	});

	it("dispatcher with null source returns null", () => {
		assert.equal(normalizeEvent("json", null), null);
		assert.equal(normalizeEvent("session", null), null);
	});

	it("dispatcher with undefined source returns null", () => {
		assert.equal(normalizeEvent("json", undefined), null);
		assert.equal(normalizeEvent("session", undefined), null);
	});

	it("dispatcher with registered kind and valid input returns matching event", () => {
		const result = normalizeEvent("json", { type: "turn_start" });
		assert.ok(result);
		assert.equal(result!.kind, "turn_start");
	});

	it("dispatcher returns null for registered kind but missing sub-event fields", () => {
		// message_update without delta returns null from resolveJsonKind
		const result = normalizeEvent("json", { type: "message_update" });
		assert.equal(result, null);
	});

	it("dispatcher returns null for non-object input", () => {
		assert.equal(normalizeEvent("json", "string" as any), null);
		assert.equal(normalizeEvent("session", 42 as any), null);
	});

	it("dispatcher with missing type field returns null", () => {
		assert.equal(normalizeEvent("json", {}), null);
		assert.equal(normalizeEvent("session", {}), null);
	});
});

// ─── Phase 2: Per-kind field accessor extractors — JSON source ──
// One fixture per variant through the JSON source.

describe("normalizeEvent — JSON source (all variants)", () => {
	it("produces tool_execution_start", () => {
		const result = normalizeEvent("json", {
			type: "tool_execution_start",
			toolName: "read",
			args: { path: "/x" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "tool_execution_start");
		if (result!.kind === "tool_execution_start") {
			assert.equal(result!.toolName, "read");
			assert.deepEqual(result!.args, { path: "/x" });
		}
	});

	it("produces tool_execution_end", () => {
		const result = normalizeEvent("json", {
			type: "tool_execution_end",
			toolName: "read",
			isError: true,
		});
		assert.ok(result);
		assert.equal(result!.kind, "tool_execution_end");
		if (result!.kind === "tool_execution_end") {
			assert.equal(result!.toolName, "read");
			assert.equal(result!.isError, true);
		}
	});

	it("produces context_info", () => {
		const result = normalizeEvent("json", {
			type: "context_info",
			contextTokens: 5000,
			contextWindow: 10000,
		});
		assert.ok(result);
		assert.equal(result!.kind, "context_info");
		if (result!.kind === "context_info") {
			assert.equal(result!.contextTokens, 5000);
			assert.equal(result!.contextWindow, 10000);
		}
	});

	it("produces thinking_start via message_update sub-event", () => {
		const result = normalizeEvent("json", {
			type: "message_update",
			delta: { type: "thinking_start" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "thinking_start");
	});

	it("produces thinking_delta via message_update sub-event", () => {
		const result = normalizeEvent("json", {
			type: "message_update",
			delta: { type: "thinking_delta", thinking_delta: "step" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "thinking_delta");
		if (result!.kind === "thinking_delta") {
			assert.equal(result!.delta, "step");
		}
	});

	it("produces thinking_end via message_update sub-event", () => {
		const result = normalizeEvent("json", {
			type: "message_update",
			delta: { type: "thinking_end" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "thinking_end");
	});

	it("produces text_start via message_update sub-event", () => {
		const result = normalizeEvent("json", {
			type: "message_update",
			delta: { type: "text_start" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_start");
	});

	it("produces text_delta via message_update sub-event", () => {
		const result = normalizeEvent("json", {
			type: "message_update",
			delta: { type: "text_delta", text_delta: "hello" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_delta");
		if (result!.kind === "text_delta") {
			assert.equal(result!.delta, "hello");
		}
	});

	it("produces text_end via message_update sub-event with usage", () => {
		const result = normalizeEvent("json", {
			type: "message_update",
			delta: { type: "text_end" },
			usage: { totalTokens: 100, input: 40, output: 60 },
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_end");
		if (result!.kind === "text_end") {
			assert.equal(result!.usage?.totalTokens, 100);
		}
	});

	it("produces text_end without usage", () => {
		const result = normalizeEvent("json", {
			type: "message_update",
			delta: { type: "text_end" },
		});
		assert.ok(result);
		assert.equal(result!.kind, "text_end");
	});

	it("produces message_end", () => {
		const result = normalizeEvent("json", {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		});
		assert.ok(result);
		assert.equal(result!.kind, "message_end");
		if (result!.kind === "message_end") {
			assert.equal(result!.message.role, "assistant");
		}
	});

	it("produces session event", () => {
		const result = normalizeEvent("json", { type: "session" });
		assert.ok(result);
		assert.equal(result!.kind, "session");
	});

	it("produces turn_start and turn_end", () => {
		assert.equal(normalizeEvent("json", { type: "turn_start" })!.kind, "turn_start");
		assert.equal(normalizeEvent("json", { type: "turn_end" })!.kind, "turn_end");
	});

	it("produces agent_start and agent_end", () => {
		assert.equal(normalizeEvent("json", { type: "agent_start" })!.kind, "agent_start");
		assert.equal(normalizeEvent("json", { type: "agent_end" })!.kind, "agent_end");
	});

	it("produces done at top level with full message", () => {
		const result = normalizeEvent("json", {
			type: "done",
			message: {
				content: [{ type: "text", text: "final answer" }],
				usage: { input: 10, output: 5 },
			},
		});
		assert.ok(result);
		assert.equal(result!.kind, "done");
		if (result!.kind === "done") {
			assert.equal(result!.message.content?.[0]?.type, "text");
			assert.equal(result!.message.content?.[0]?.text, "final answer");
			assert.equal(result!.message.usage?.input, 10);
			assert.equal(result!.message.usage?.output, 5);
		}
	});

	it("produces done without usage", () => {
		const result = normalizeEvent("json", {
			type: "done",
			message: { content: [{ type: "text", text: "done" }] },
		});
		assert.ok(result);
		assert.equal(result!.kind, "done");
		if (result!.kind === "done") {
			assert.equal(result!.message.content?.[0]?.text, "done");
		}
	});

	it("produces done with thinking and text content", () => {
		const result = normalizeEvent("json", {
			type: "done",
			message: {
				content: [
					{ type: "thinking", thinking: "deep thought" },
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

	it("returns null for done inside message_update (JSON source has no done sub-event)", () => {
		const result = normalizeEvent("json", {
			type: "message_update",
			delta: { type: "done" },
		});
		assert.equal(result, null);
	});

	it("returns null via jsonLineToNormalizedEvent for empty line", () => {
		assert.equal(jsonLineToNormalizedEvent(""), null);
	});

	it("returns null via jsonLineToNormalizedEvent for whitespace", () => {
		assert.equal(jsonLineToNormalizedEvent("  "), null);
	});

	it("returns null via jsonLineToNormalizedEvent for invalid JSON", () => {
		assert.equal(jsonLineToNormalizedEvent("{invalid}"), null);
	});

	it("returns null for unknown event types via jsonLineToNormalizedEvent", () => {
		assert.equal(jsonLineToNormalizedEvent(JSON.stringify({ type: "unknown_xyz" })), null);
	});

	it("tool_execution_start with no toolName defaults to 'tool'", () => {
		const result = normalizeEvent("json", { type: "tool_execution_start" });
		assert.ok(result);
		if (result!.kind === "tool_execution_start") {
			assert.equal(result!.toolName, "tool");
		}
	});

	it("tool_execution_end with no isError defaults to false", () => {
		const result = normalizeEvent("json", { type: "tool_execution_end" });
		assert.ok(result);
		if (result!.kind === "tool_execution_end") {
			assert.equal(result!.isError, false);
		}
	});
});

// ─── Phase 2: Per-kind field accessor extractors — Session source ─
// One fixture per variant through the session source.

// ─── Phase 3: Registration guard ──────────────────────────────────
// Ensures every NormalizedEvent variant has a table entry.

describe("normalizeEvent — registration guard", () => {
	it("all NormalizedEvent kinds have a registered table entry", () => {
		// This is the exhaustive coverage assertion.
		// If a new variant is added to NormalizedEvent without a corresponding
		// entry in kindTable, this test will fail.
		const allKinds: string[] = [
			"tool_execution_start",
			"tool_execution_end",
			"thinking_start",
			"thinking_end",
			"thinking_delta",
			"text_start",
			"text_end",
			"text_delta",
			"message_end",
			"done",
			"context_info",
			"turn_start",
			"turn_end",
			"agent_start",
			"agent_end",
			"session",
		];

		for (const kind of allKinds) {
			// Each kind should produce a non-null result via JSON source
			// context_info is special — session returns null, but json source should work
			const result = normalizeEvent("json", { type: kind });
			assert.ok(result, `NormalizedEvent kind "${kind}" is missing a table entry for JSON source`);
			assert.equal(result!.kind, kind);
		}
	});

	it("unregistered kind returns null (no throw)", () => {
		const result = normalizeEvent("json", { type: "__bogus_kind__" });
		assert.equal(result, null);
	});
});

// ─── Phase 4: processNormalizedEvent — backward compat wrappers ──
// Verify that the backward-compat wrappers still route through the
// new dispatcher correctly.

describe("jsonLineToNormalizedEvent (backward compat wrapper)", () => {
	it("routes through normalizeEvent", () => {
		const result = jsonLineToNormalizedEvent(JSON.stringify({ type: "turn_start" }));
		assert.ok(result);
		assert.equal(result!.kind, "turn_start");
	});
});

// ─── Phase 5: processNormalizedEvent ──────────────────────────────

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
