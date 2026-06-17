/**
 * Tests: session/result.ts — convertAgentRunToToolResult adapter
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/session/result.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertAgentRunToToolResult } from "../../session/result.ts";
import type { AgentRunResult } from "../../config/types.ts";
import type { SubagentDetails, TextContent } from "../../subagent/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────

function makeRunResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
	return {
		output: "some output",
		success: true,
		agentName: "developer",
		toolCount: 5,
		failedToolCount: 0,
		tokenCount: 1500,
		durationMs: 30000,
		textOutput: "text output",
		summaryLine: "Completed task",
		errorOutput: "",
		textOnly: "text only",
		thinkingOutput: "I think therefore I am",
		budgetExceeded: false,
		model: "claude-sonnet-4",
		inputTokens: 500,
		outputTokens: 1000,
		cacheRead: 200,
		cacheWrite: 100,
		cost: 0.0123,
		turnCount: 3,
		...overrides,
	};
}

// ─── Phase 1: Happy path ─────────────────────────────────────────

describe("convertAgentRunToToolResult — happy path", () => {
	it("maps all AgentRunResult fields to AgentToolResult<SubagentDetails>", () => {
		const result = makeRunResult();
		const toolResult = convertAgentRunToToolResult(result, "Fix merge conflict");

		assert.equal(toolResult.content.length, 1);
		assert.equal(toolResult.content[0].type, "text");
		assert.equal((toolResult.content[0] as TextContent).text, "text output");

		const d = toolResult.details;
		assert.equal(d.agentName, "developer");
		assert.equal(d.success, true);
		assert.equal(d.statusLabel, "SUCCESS");
		assert.equal(d.summaryLine, "Completed task");
		assert.equal(d.model, "claude-sonnet-4");
		assert.equal(d.inputTokens, 500);
		assert.equal(d.outputTokens, 1000);
		assert.equal(d.cacheRead, 200);
		assert.equal(d.cacheWrite, 100);
		assert.equal(d.cost, 0.0123);
		assert.equal(d.turnCount, 3);
		assert.equal(d.durationMs, 30000);
		assert.equal(d.thinkingOutput, "I think therefore I am");
	});

	it("content[0].text comes from textOutput", () => {
		const result = makeRunResult({ textOutput: "my text output", output: "raw output" });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal((toolResult.content[0] as TextContent).text, "my text output");
	});

	it("falls back to output when textOutput is empty", () => {
		const result = makeRunResult({ textOutput: "", output: "raw fallback" });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal((toolResult.content[0] as TextContent).text, "raw fallback");
	});

	it("details.toolCalls and details.toolResults default to empty arrays", () => {
		const result = makeRunResult();
		const toolResult = convertAgentRunToToolResult(result);
		assert.deepEqual(toolResult.details.toolCalls, []);
		assert.deepEqual(toolResult.details.toolResults, []);
	});

	it("details.taskPrompt set to provided devTask argument", () => {
		const result = makeRunResult();
		const toolResult = convertAgentRunToToolResult(result, "Resolve merge conflict in file.ts");
		assert.equal(toolResult.details.taskPrompt, "Resolve merge conflict in file.ts");
	});

	it("details.taskPrompt is empty string when devTask omitted", () => {
		const result = makeRunResult();
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal(toolResult.details.taskPrompt, "");
	});

	it("details.statusLabel derived from result.success: SUCCESS", () => {
		const result = makeRunResult({ success: true });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal(toolResult.details.statusLabel, "SUCCESS");
	});

	it("details.statusLabel derived from result.success: FAILED", () => {
		const result = makeRunResult({ success: false });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal(toolResult.details.statusLabel, "FAILED");
	});

	it("details.errorCount set from result.failedToolCount when defined", () => {
		const result = makeRunResult({ failedToolCount: 2 });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal(toolResult.details.errorCount, 2);
	});
});

// ─── Phase 1: Edge cases ────────────────────────────────────────

describe("convertAgentRunToToolResult — edge cases", () => {
	it("textOutput empty string → content[0].text is empty string", () => {
		const result = makeRunResult({ textOutput: "", output: "" });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal((toolResult.content[0] as TextContent).text, "");
	});

	it("thinkingOutput undefined → details.thinkingOutput absent", () => {
		const result = makeRunResult({ thinkingOutput: undefined });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal(toolResult.details.thinkingOutput, undefined);
	});

	it("optional numeric fields undefined → zero defaults", () => {
		const result = makeRunResult({
			inputTokens: undefined,
			outputTokens: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
			cost: undefined,
			turnCount: undefined,
		});
		const toolResult = convertAgentRunToToolResult(result);
		const d = toolResult.details;
		assert.equal(d.inputTokens, 0);
		assert.equal(d.outputTokens, 0);
		assert.equal(d.cacheRead, 0);
		assert.equal(d.cacheWrite, 0);
		assert.equal(d.cost, 0);
		assert.equal(d.turnCount, 0);
	});

	it("budgetExceeded boolean maps correctly", () => {
		const result = makeRunResult({ budgetExceeded: true });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal(toolResult.details.budgetExceeded, true);

		const result2 = makeRunResult({ budgetExceeded: false });
		const toolResult2 = convertAgentRunToToolResult(result2);
		assert.equal(toolResult2.details.budgetExceeded, false);
	});

	it("failedToolCount undefined → details.errorCount undefined", () => {
		const result = makeRunResult({ failedToolCount: undefined });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal(toolResult.details.errorCount, undefined);
	});

	it("model undefined → empty string in details", () => {
		const result = makeRunResult({ model: undefined });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal(toolResult.details.model, "");
	});

	it("summaryLine empty string → preserved as empty string", () => {
		const result = makeRunResult({ summaryLine: "" });
		const toolResult = convertAgentRunToToolResult(result);
		assert.equal(toolResult.details.summaryLine, "");
	});
});
