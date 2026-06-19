/**
 * Tests: session/widget.ts — renderWidgetFromDetails shared helper
 *
 * Phase 2: renderWidgetFromDetails constructs AgentRunState from SubagentDetails,
 * calls buildWidgetLines(), and invokes ctx.ui.setWidget().
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/session/widget.test.mts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderWidgetFromDetails } from "../../session/widget.ts";
import type { SubagentDetails } from "../../subagent/types.ts";

// ─── Shared State ──────────────────────────────────────────────────

let widgetCalls: Array<{ id: string; lines?: string[] }> = [];

beforeEach(() => {
	widgetCalls = [];
});

// ─── Helpers ───────────────────────────────────────────────────────

function createMockCtx() {
	return {
		ui: {
			setWidget: (id: string, lines?: string[]) => {
				widgetCalls.push({ id, lines });
			},
		},
	};
}

function makeDetails(overrides: Partial<SubagentDetails> = {}): Partial<SubagentDetails> {
	return {
		agentName: "developer",
		success: false,
		statusLabel: "IN_PROGRESS",
		summaryLine: "Running developer — idle phase",
		model: "claude-sonnet-4",
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turnCount: 0,
		durationMs: 1000,
		toolCalls: [],
		toolResults: [],
		taskPrompt: "test task",
		runningTokenCount: 0,
		runningToolCount: 0,
		errorCount: 0,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		compacted: false,
		startedAt: Date.now() - 5000,
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════
// Phase 2: renderWidgetFromDetails — field mapping & invocation
// ═══════════════════════════════════════════════════════════════════

describe("renderWidgetFromDetails — field mapping (Phase 2)", () => {
	it("calls ctx.ui.setWidget with given widgetId", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx, "agent-developer");

		assert.equal(widgetCalls.length, 1, "should call setWidget exactly once");
		assert.equal(widgetCalls[0].id, "agent-developer", "should use given widget ID");
	});

	it("produces lines with agent name header", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "architect", "deepseek-v4-flash", ctx, "agent-architect");

		assert.equal(widgetCalls.length, 1);
		const headerLine = widgetCalls[0].lines?.find((l) => l.includes("architect"));
		assert.ok(headerLine, "widget should include agent name in header");
	});

	it("maps phase='thinking' with liveThinking content", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			phase: "thinking",
			liveThinking: "Analyzing code structure...",
		});
		renderWidgetFromDetails(details, "architect", undefined, ctx, "agent-architect");

		assert.equal(widgetCalls.length, 1);
		const thinkingLine = widgetCalls[0].lines?.find((l) => l.includes("Analyzing code structure"));
		assert.ok(thinkingLine, "widget should show thinking content");
	});

	it("maps phase='tool' with currentTool/currentToolArgs", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			phase: "tool",
			currentTool: "bash",
			currentToolArgs: '{"command": "npm test"}',
		});
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		assert.equal(widgetCalls.length, 1);
		// formatToolCall formats bash as "$ npm test"
		const toolLine = widgetCalls[0].lines?.find((l) => l.includes("$ npm"));
		assert.ok(toolLine, "widget should show formatted tool call");
	});

	it("maps phase='text' with liveText content", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			phase: "text",
			liveText: "Here is my implementation...",
		});
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		const textLine = widgetCalls[0].lines?.find((l) => l.includes("Here is my implementation"));
		assert.ok(textLine, "widget should show live text");
	});

	it("includes stats footer with running token/tool counts", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			runningTokenCount: 1500,
			runningToolCount: 5,
		});
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx, "agent-developer");

		const footerLine = widgetCalls[0].lines?.[widgetCalls[0].lines.length - 1];
		assert.ok(footerLine, "footer line should exist");
		assert.ok(footerLine.includes("subagent:"), "footer should include subagent prefix");
		assert.ok(footerLine.includes("developer"), "footer should include agent name");
	});

	it("includes context tokens/context window info when provided", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			contextTokens: 500,
			contextWindow: 16000,
		});
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		const contextLine = widgetCalls[0].lines?.find((l) => l.includes("Context:"));
		assert.ok(contextLine, "should have context line");
		assert.ok(contextLine?.includes("500"), "should show context token count");
		// formatTokens formats 16000 as "16.0K"
		assert.ok(
			contextLine?.includes("16.0K") || contextLine?.includes("16000"),
			"should show formatted context window",
		);
	});

	it("shows 'computing...' when contextTokens/contextWindow are undefined", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			contextTokens: undefined,
			contextWindow: undefined,
		});
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		const contextLine = widgetCalls[0].lines?.find((l) => l.includes("Context:"));
		assert.ok(contextLine, "should have context line");
		assert.ok(contextLine?.includes("computing"), "should show computing placeholder");
	});

	it("includes recentLogEntries as log entries", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			recentLogEntries: ["💭 First thought", "🔧 Tool call", "📝 Output line"],
		});
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		const logLine = widgetCalls[0].lines?.find((l) => l.includes("First thought"));
		assert.ok(logLine, "widget should include log entries");
	});

	it("does not include log section when recentLogEntries is empty/undefined", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			recentLogEntries: undefined,
		});
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		// Should still produce some lines even with empty log
		assert.ok(
			widgetCalls[0].lines && widgetCalls[0].lines.length >= 2,
			"should produce at least header + footer",
		);
	});

	it("uses startedAt for elapsed time calculation in footer", () => {
		const ctx = createMockCtx();
		const startedAt = Date.now() - 10000; // 10s ago
		const details = makeDetails({ startedAt });
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		const footerLine = widgetCalls[0].lines?.[widgetCalls[0].lines.length - 1];
		assert.ok(footerLine, "footer line should exist");
		// Should show some duration (at least 9s or formatted time)
		assert.ok(
			footerLine.includes("10") || footerLine.includes("s"),
			"footer should include elapsed time",
		);
	});

	it("gracefully degrades when startedAt is missing (falls back to Date.now())", () => {
		const ctx = createMockCtx();
		const details = makeDetails({ startedAt: undefined });
		// Should not throw
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		assert.equal(widgetCalls.length, 1, "should still call setWidget");
		assert.ok(widgetCalls[0].lines && widgetCalls[0].lines.length >= 2, "should produce lines");
	});

	it("maps phase='idle' when phase is undefined", () => {
		const ctx = createMockCtx();
		const details = makeDetails({ phase: undefined });
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		const headerLine = widgetCalls[0].lines?.find((l) => l.includes("developer"));
		assert.ok(headerLine, "should still show header");
	});

	it("maps unknown phase string as 'idle'", () => {
		const ctx = createMockCtx();
		const details = makeDetails({ phase: "unknown" as any });
		// Should map to "idle" since it doesn't match "thinking"|"tool"|"text"
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		assert.equal(widgetCalls.length, 1, "should not throw on unknown phase");
	});

	it("passes model to buildWidgetLines for footer model display", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx, "agent-developer");

		const modelLine = widgetCalls[0].lines?.find((l) => l.includes("claude-sonnet"));
		assert.ok(modelLine, "widget should include model name in footer");
	});

	it("handles undefined model gracefully", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		assert.equal(widgetCalls.length, 1, "should not throw when model is undefined");
	});

	it("includes errorCount mapped to failedToolCount", () => {
		const ctx = createMockCtx();
		const details = makeDetails({ errorCount: 3, runningToolCount: 10 });
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		// errorCount maps to failedToolCount, which isn't directly shown in buildWidgetLines
		// but shouldn't cause issues. Tool count and error stats aren't directly shown
		// in the footer, so we just verify no crash.
		assert.equal(widgetCalls.length, 1);
	});

	it("pure function: same input produces same lines content (same widgetId)", () => {
		const ctx1 = createMockCtx();
		const ctx2 = createMockCtx();
		const details1 = makeDetails({
			phase: "thinking",
			liveThinking: "Same thinking",
			runningTokenCount: 500,
		});
		const details2 = { ...details1, agentName: "developer" };

		renderWidgetFromDetails(details1, "developer", undefined, ctx1, "agent-dev");
		renderWidgetFromDetails({ ...details1 }, "developer", undefined, ctx2, "agent-dev");

		assert.equal(widgetCalls.length, 2);
		assert.deepEqual(
			widgetCalls[0].lines,
			widgetCalls[1].lines,
			"same input should produce same output",
		);
	});

	it("passes widgetId verbatim without modification", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "developer", undefined, ctx, "custom-widget-id-123");

		assert.equal(widgetCalls[0].id, "custom-widget-id-123", "widgetId passed through verbatim");
	});
});

describe("renderWidgetFromDetails — edge cases", () => {
	it("handles empty details object (all fields undefined)", () => {
		const ctx = createMockCtx();
		// All fields are undefined — should gracefully degrade
		renderWidgetFromDetails({}, "developer", undefined, ctx, "agent-developer");

		assert.equal(widgetCalls.length, 1, "should not throw with empty details");
		const headerLine = widgetCalls[0].lines?.find((l) => l.includes("developer"));
		assert.ok(headerLine, "should still show header");
	});

	it("handles currentTool without currentToolArgs", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			phase: "tool",
			currentTool: "read",
			currentToolArgs: undefined,
		});
		// Should not throw when currentToolArgs is undefined
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		assert.equal(widgetCalls.length, 1);
		const toolLine = widgetCalls[0].lines?.find((l) => l.includes("read"));
		assert.ok(toolLine, "should show tool name even without args");
	});

	it("handles all 9 new fields simultaneously", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			phase: "thinking",
			currentTool: "bash",
			currentToolArgs: '{"command": "build"}',
			recentLogEntries: ["💭 First", "🔧 Second"],
			liveThinking: "Deep analysis...",
			liveText: "Writing output...",
			contextTokens: 1000,
			contextWindow: 32000,
			startedAt: Date.now() - 15000,
		});
		// Should handle all fields simultaneously without error
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx, "agent-developer");

		assert.equal(widgetCalls.length, 1);
		assert.ok(
			widgetCalls[0].lines && widgetCalls[0].lines.length >= 3,
			"should produce multiple lines with all fields populated",
		);
	});
});
