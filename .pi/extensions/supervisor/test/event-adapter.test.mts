// ─── Tests: event-adapter.ts — adapters + processNormalizedEvent ──
// Phase 3+4: JSON line adapter, session event adapter, unified processor.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunState } from "../config/types";
import { normalizeEvent, jsonLineToNormalizedEvent } from "../event/adapter.ts";

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
