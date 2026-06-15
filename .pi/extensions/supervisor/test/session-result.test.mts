// ─── Tests: session-result.ts — Phase 4 truncation ────────────────
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildAgentRunResult,
	buildRawOutputFromMessages,
	convertToolResultToAgentRunResult,
} from "../session/result.ts";
import type { AgentRunState, AgentRunResult } from "../config/types";
import type { AgentToolResult, SubagentDetails } from "../subagent/types.ts";

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

function makeToolUse(
	name: string,
	inputObj: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "tool_use",
		name,
		input: inputObj,
	};
}

function makeToolResult(content: string, toolName?: string): Record<string, unknown> {
	return {
		type: "tool_result",
		content: [{ type: "text", text: content }],
		toolName: toolName || "read_file",
	};
}

function makeTextBlock(text: string): Record<string, unknown> {
	return { type: "text", text };
}

function makeThinkingBlock(thinking: string): Record<string, unknown> {
	return { type: "thinking", thinking };
}

// ─── buildRawOutputFromMessages ───────────────────────────────────

describe("buildRawOutputFromMessages — truncation (Phase 4)", () => {
	it("empty messages array returns empty string", () => {
		assert.equal(buildRawOutputFromMessages([]), "");
	});

	it("null/undefined messages array returns empty string", () => {
		assert.equal(buildRawOutputFromMessages(null as any), "");
		assert.equal(buildRawOutputFromMessages(undefined as any), "");
	});

	it("tool_use.input < 500 chars passed through verbatim", () => {
		const messages = [
			{
				role: "assistant",
				content: [makeToolUse("read", { path: "/short/path.txt" })],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		assert.ok(output.includes("/short/path.txt"), "short input should pass through");
	});

	it("tool_use.input > 500 chars truncated with overflow indicator", () => {
		const longStr = "x".repeat(600);
		const messages = [
			{
				role: "assistant",
				content: [makeToolUse("read", { path: longStr })],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		// Should be truncated
		assert.ok(output.length < 3000, "output should be truncated");
		// Should contain overflow indicator
		assert.ok(
			output.includes("+") || output.includes("…") || output.includes("truncated"),
			`output should contain overflow indicator, got: ${output.slice(500, 600)}`,
		);
		// Total output should still contain the tool name
		assert.ok(output.includes("read"), "tool name should still be present");
	});

	it("tool_result.content < 2000 chars passed through verbatim", () => {
		const messages = [
			{
				role: "user",
				content: [makeToolResult("short result")],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		assert.ok(output.includes("short result"), "short content should pass through");
	});

	it("tool_result.content > 2000 chars truncated with overflow indicator", () => {
		const longContent = "y".repeat(2500);
		const messages = [
			{
				role: "user",
				content: [makeToolResult(longContent)],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		// Should contain the truncation note
		assert.ok(
			output.includes("+") ||
				output.includes("more chars") ||
				output.includes("truncated") ||
				output.includes("…"),
			`output should contain overflow indicator, length: ${output.length}`,
		);
		assert.ok(output.length < 5000, "output should be significantly truncated");
	});

	it("total rawOutput > 100K chars truncated after last complete message boundary", () => {
		const largeBlock = makeTextBlock("A".repeat(120000));
		const messages = [
			{
				role: "assistant",
				content: [largeBlock],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		// Output should be <= 100K + a small buffer for the role header
		assert.ok(
			output.length <= 101000,
			`output length ${output.length} should be near or under 100K limit`,
		);
	});

	it("messages with empty content arrays produces empty output", () => {
		const messages = [
			{ role: "assistant", content: [] },
			{ role: "user", content: [] },
		];
		const output = buildRawOutputFromMessages(messages);
		assert.equal(output, "", "empty content arrays should produce no output");
	});

	it("non-string tool_use.input (object) — JSON.stringify before truncation", () => {
		const messages = [
			{
				role: "assistant",
				content: [makeToolUse("edit", { file: "test.ts", content: "nested object" })],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		assert.ok(output.includes("test.ts"), "should contain stringified content");
		assert.ok(output.includes("nested object"), "should contain stringified content");
	});

	it("tool_result.content as string (not array) — truncation still applied", () => {
		const longStr = "z".repeat(3000);
		const messages = [
			{
				role: "user",
				toolName: "bash",
				content: [makeToolResult(longStr, "bash")],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		// Content should be truncated
		assert.ok(output.includes("TOOL_RESULT: bash"), "tool result header should appear");
		assert.ok(output.includes("+") || output.includes("..."), "truncation indicator should appear");
	});

	it("thinking blocks passed through as-is", () => {
		const messages = [
			{
				role: "assistant",
				content: [makeThinkingBlock("deep thought process")],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		assert.ok(output.includes("deep thought process"), "thinking content should pass through");
		assert.ok(output.includes("THINKING"), "thinking header should appear");
	});
});

// ─── Helpers for breakdown extraction tests ────────────────────────

function makeUsage(
	input?: number,
	output?: number,
	cacheRead?: number,
	cacheWrite?: number,
	cost?: number,
	totalTokens?: number,
): Record<string, unknown> | undefined {
	const usage: Record<string, unknown> = {};
	if (input !== undefined) usage.input = input;
	if (output !== undefined) usage.output = output;
	if (cacheRead !== undefined) usage.cacheRead = cacheRead;
	if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
	if (cost !== undefined) usage.cost = { total: cost };
	if (totalTokens !== undefined) usage.totalTokens = totalTokens;
	return Object.keys(usage).length > 0 ? usage : undefined;
}

function makeMessage(
	role: string,
	contentBlocks?: Record<string, unknown>[],
	usage?: Record<string, unknown>,
): Record<string, unknown> {
	const msg: Record<string, unknown> = {
		role,
		content: contentBlocks || [],
	};
	if (usage) msg.usage = usage;
	return msg;
}

// ─── buildAgentRunResult — breakdown extraction (Phase 2) ────────

describe("buildAgentRunResult — breakdown extraction", () => {
	it("full extraction: last assistant message has all usage fields", () => {
		const state = createState({
			cacheRead: 500,
			cacheWrite: 200,
			tokenCount: 10001,
		});
		const messages = [
			makeMessage("user", [makeTextBlock("hello")]),
			makeMessage(
				"assistant",
				[makeTextBlock("response")],
				makeUsage(1234, 8567, 500, 200, 0.0234, 10001),
			),
		];
		const result = buildAgentRunResult(state, "developer", true, 45000, messages);
		assert.equal(result.inputTokens, 1234);
		assert.equal(result.outputTokens, 8567);
		assert.equal(result.cacheRead, 500);
		assert.equal(result.cacheWrite, 200);
		assert.equal(result.cost, 0.0234);
		assert.equal(result.turnCount, 1);
	});

	it("partial usage: only input and output present, no cache/cost", () => {
		const state = createState({ tokenCount: 5000 });
		const messages = [
			makeMessage("user", [makeTextBlock("hello")]),
			makeMessage("assistant", [makeTextBlock("response")], makeUsage(1000, 2000)),
		];
		const result = buildAgentRunResult(state, "developer", true, 10000, messages);
		assert.equal(result.inputTokens, 1000);
		assert.equal(result.outputTokens, 2000);
		assert.equal(result.cacheRead, undefined);
		assert.equal(result.cacheWrite, undefined);
		assert.equal(result.cost, undefined);
		assert.equal(result.turnCount, 1);
	});

	it("no usage on any message — all new fields undefined", () => {
		const state = createState({ tokenCount: 500 });
		const messages = [
			makeMessage("user", [makeTextBlock("hello")]),
			makeMessage("assistant", [makeTextBlock("response")]),
		];
		const result = buildAgentRunResult(state, "developer", true, 5000, messages);
		assert.equal(result.inputTokens, undefined);
		assert.equal(result.outputTokens, undefined);
		assert.equal(result.cacheRead, undefined);
		assert.equal(result.cacheWrite, undefined);
		assert.equal(result.cost, undefined);
		assert.equal(result.turnCount, undefined);
		assert.equal(result.tokenCount, 500); // fallback to state.tokenCount
	});

	it("empty messages array — all new fields undefined", () => {
		const state = createState({ tokenCount: 0 });
		const result = buildAgentRunResult(state, "developer", true, 1000, []);
		assert.equal(result.inputTokens, undefined);
		assert.equal(result.outputTokens, undefined);
		assert.equal(result.cost, undefined);
		assert.equal(result.turnCount, undefined);
	});

	it("null/undefined messages array — all new fields undefined", () => {
		const state = createState({ tokenCount: 0 });
		const result1 = buildAgentRunResult(state, "developer", true, 1000, null as any);
		assert.equal(result1.inputTokens, undefined);
		assert.equal(result1.turnCount, undefined);

		const result2 = buildAgentRunResult(state, "developer", true, 1000, undefined as any);
		assert.equal(result2.inputTokens, undefined);
		assert.equal(result2.turnCount, undefined);
	});

	it("multiple assistant messages — last with usage wins", () => {
		const state = createState({ cacheRead: 300, cacheWrite: 100, tokenCount: 9999 });
		const messages = [
			makeMessage("user", [makeTextBlock("q1")]),
			makeMessage(
				"assistant",
				[makeTextBlock("a1")],
				makeUsage(100, 200, undefined, undefined, 0.001, 300),
			),
			makeMessage("user", [makeTextBlock("q2")]),
			makeMessage(
				"assistant",
				[makeTextBlock("a2")],
				makeUsage(2000, 4000, undefined, undefined, 0.005, 6000),
			),
		];
		const result = buildAgentRunResult(state, "developer", true, 30000, messages);
		// Last assistant message usage wins
		assert.equal(result.inputTokens, 2000);
		assert.equal(result.outputTokens, 4000);
		assert.equal(result.cost, 0.005);
		// Turn count counts all assistant messages with usage.input > 0
		assert.equal(result.turnCount, 2);
	});

	it("assistant messages but none with usage — turnCount is 0 (undefined)", () => {
		const state = createState({ tokenCount: 0 });
		const messages = [
			makeMessage("user", [makeTextBlock("q")]),
			makeMessage("assistant", [makeTextBlock("a")]),
			makeMessage("assistant", [makeTextBlock("a2")]),
		];
		const result = buildAgentRunResult(state, "developer", true, 5000, messages);
		assert.equal(result.inputTokens, undefined);
		assert.equal(result.outputTokens, undefined);
		assert.equal(result.turnCount, undefined);
	});

	it("usage.cost.total is 0 — cost set to 0", () => {
		const state = createState({ tokenCount: 100 });
		const messages = [
			makeMessage(
				"assistant",
				[makeTextBlock("response")],
				makeUsage(50, 50, undefined, undefined, 0, 100),
			),
		];
		const result = buildAgentRunResult(state, "developer", true, 1000, messages);
		assert.equal(result.cost, 0);
	});

	it("usage.cost missing but input/output present — cost undefined", () => {
		const state = createState({ tokenCount: 100 });
		const messages = [makeMessage("assistant", [makeTextBlock("response")], makeUsage(50, 50))];
		const result = buildAgentRunResult(state, "developer", true, 1000, messages);
		assert.equal(result.inputTokens, 50);
		assert.equal(result.outputTokens, 50);
		assert.equal(result.cost, undefined);
	});

	it("cacheRead/cacheWrite come from state, not from raw messages", () => {
		const state = createState({ cacheRead: 999, cacheWrite: 888, tokenCount: 500 });
		const messages = [
			makeMessage("assistant", [makeTextBlock("hi")], makeUsage(100, 200, 111, 222, 0.01, 300)),
		];
		const result = buildAgentRunResult(state, "developer", true, 5000, messages);
		// Cache values come from state, not from usage
		assert.equal(result.cacheRead, 999);
		assert.equal(result.cacheWrite, 888);
	});

	it("tokenCount stable: existing fallback logic unchanged when new fields absent", () => {
		const state = createState({ tokenCount: 500 });
		const messages = [
			makeMessage("user", [makeTextBlock("q")]),
			makeMessage("assistant", [makeTextBlock("a")]),
		];
		const result = buildAgentRunResult(state, "developer", true, 5000, messages);
		assert.equal(result.tokenCount, 500);
		assert.equal(result.inputTokens, undefined);
	});
});

// ─── buildAgentRunResult — budgetExceeded propagation ─────────────

describe("buildAgentRunResult — budgetExceeded propagation", () => {
	it("includes budgetExceeded from state when true", () => {
		const state = createState({
			budgetExceeded: true,
			budgetExceededReason: "Tool limit",
			toolCount: 30,
			maxToolCalls: 30,
		});
		const result = buildAgentRunResult(state, "developer", true, 1000, []);
		assert.equal(result.budgetExceeded, true);
	});

	it("does not set budgetExceeded when state has false", () => {
		const state = createState({ budgetExceeded: false });
		const result = buildAgentRunResult(state, "developer", true, 1000, []);
		assert.equal(result.budgetExceeded, undefined);
	});
});

// ─── convertToolResultToAgentRunResult — budgetExceeded propagation ──

describe("convertToolResultToAgentRunResult — budgetExceeded propagation", () => {
	function makeToolResult(overrides?: Partial<SubagentDetails>): AgentToolResult<SubagentDetails> {
		const d: SubagentDetails = {
			agentName: "researcher",
			success: true,
			statusLabel: "SUCCESS",
			summaryLine: "Research complete",
			model: "model",
			inputTokens: 100,
			outputTokens: 200,
			cacheRead: 50,
			cacheWrite: 25,
			cost: 0.01,
			turnCount: 3,
			durationMs: 5000,
			toolCalls: [{ name: "read", args: { path: "test" } }],
			taskPrompt: "task",
			budgetExceeded: overrides?.budgetExceeded,
		};
		if (overrides) {
			Object.assign(d, overrides);
		}
		return {
			content: [{ type: "text" as const, text: "Research results" }],
			details: d,
		};
	}

	it("propagates budgetExceeded=true when d.budgetExceeded=true", () => {
		const result = convertToolResultToAgentRunResult(makeToolResult({ budgetExceeded: true }));
		assert.equal(result.budgetExceeded, true);
	});

	it("derives budgetExceeded=true when d.statusLabel=BUDGET_EXCEEDED and d.budgetExceeded undefined", () => {
		const result = convertToolResultToAgentRunResult(
			makeToolResult({ statusLabel: "BUDGET_EXCEEDED", budgetExceeded: undefined }),
		);
		assert.equal(result.budgetExceeded, true);
	});

	it("budgetExceeded is undefined when d.budgetExceeded undefined and d.statusLabel=SUCCESS", () => {
		const result = convertToolResultToAgentRunResult(
			makeToolResult({ statusLabel: "SUCCESS", budgetExceeded: undefined }),
		);
		assert.equal(result.budgetExceeded, undefined);
	});

	it("budgetExceeded is undefined when d.budgetExceeded undefined and d.statusLabel=FAILED", () => {
		const result = convertToolResultToAgentRunResult(
			makeToolResult({ statusLabel: "FAILED", budgetExceeded: undefined }),
		);
		assert.equal(result.budgetExceeded, undefined);
	});

	it("d.budgetExceeded=false produces undefined (not false), unused field convention", () => {
		const result = convertToolResultToAgentRunResult(makeToolResult({ budgetExceeded: false }));
		assert.equal(result.budgetExceeded, undefined);
	});

	it("all other fields unchanged from current mapping — regression guard", () => {
		const tr = makeToolResult({ success: true, agentName: "researcher" });
		const result = convertToolResultToAgentRunResult(tr);
		assert.equal(result.success, true);
		assert.equal(result.agentName, "researcher");
		assert.equal(result.toolCount, 1);
		assert.equal(result.tokenCount, 375); // 100 + 200 + 50 + 25
		assert.equal(result.durationMs, 5000);
		assert.equal(result.textOutput, "Research results");
		assert.equal(result.textOnly, "Research results");
		assert.ok(result.summaryLine && result.summaryLine.length > 0);
		assert.equal(result.errorOutput, "");
		assert.equal(result.thinkingOutput, undefined);
		assert.equal(result.model, "model");
		assert.equal(result.inputTokens, 100);
		assert.equal(result.outputTokens, 200);
		assert.equal(result.cacheRead, 50);
		assert.equal(result.cacheWrite, 25);
		assert.equal(result.cost, 0.01);
		assert.equal(result.turnCount, 3);
	});
});
