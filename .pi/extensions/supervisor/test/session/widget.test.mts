/**
 * Tests: session/widget.ts — renderWidgetFromDetails shared helper
 *
 * Widget now shows ONLY the stats footer line (no headers, logs, tools).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/session/widget.test.mts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderWidgetFromDetails } from "../../session/widget.ts";
import type { SubagentDetails } from "../../subagent/types.ts";

let widgetCalls: Array<{ id: string; lines?: string[] }> = [];

beforeEach(() => {
	widgetCalls = [];
});

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

describe("renderWidgetFromDetails — simplified widget (footer only)", () => {
	it("calls ctx.ui.setWidget with given widgetId", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx, "agent-developer");
		assert.equal(widgetCalls.length, 1);
		assert.equal(widgetCalls[0].id, "agent-developer");
	});

	it("returns exactly one line with stats footer", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx, "agent-dev");
		assert.equal(widgetCalls[0].lines?.length, 1, "should return exactly 1 line");
		const line = widgetCalls[0].lines?.[0] ?? "";
		assert.ok(line.includes("subagent:"), "should contain subagent prefix");
		assert.ok(line.includes("developer"), "should contain agent name");
	});

	it("includes model, token count, tool count, and duration in footer", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			runningTokenCount: 1500,
			runningToolCount: 5,
			startedAt: Date.now() - 10000,
		});
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx, "agent-dev");
		const line = widgetCalls[0].lines?.[0] ?? "";
		assert.ok(line.includes("claude-sonnet"), "footer should include model");
		assert.ok(line.includes("1.5K"), "footer should include token count");
		assert.ok(line.includes("5 tools"), "footer should include tool count");
		assert.ok(line.includes("10") || line.includes("s"), "footer should include duration");
	});

	it("uses short model when model has path prefix", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "developer", "anthropic/claude-sonnet-4", ctx, "agent-dev");
		const line = widgetCalls[0].lines?.[0] ?? "";
		assert.ok(line.includes("claude-sonnet-4"), "should use short model name");
		assert.ok(!line.includes("anthropic"), "should not include org prefix");
	});

	it("handles undefined model gracefully", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-dev");
		assert.equal(widgetCalls.length, 1);
	});

	it("handles undefined startedAt gracefully (falls back to Date.now())", () => {
		const ctx = createMockCtx();
		const details = makeDetails({ startedAt: undefined });
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-dev");
		assert.equal(widgetCalls.length, 1);
	});

	it("includes cache stats when cacheRead/cacheWrite > 0", () => {
		const ctx = createMockCtx();
		const details = makeDetails({ cacheRead: 1000, cacheWrite: 800 });
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-dev");
		const line = widgetCalls[0].lines?.[0] ?? "";
		assert.ok(line.includes("📦"), "footer should include cache stats");
	});

	it("omits cache stats when cacheRead/cacheWrite are 0", () => {
		const ctx = createMockCtx();
		const details = makeDetails({ cacheRead: 0, cacheWrite: 0 });
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-dev");
		const line = widgetCalls[0].lines?.[0] ?? "";
		assert.ok(!line.includes("📦"), "footer should not include cache stats when 0");
	});

	it("no crash for unknown phase values", () => {
		const ctx = createMockCtx();
		const details = makeDetails({ phase: "unknown" as any });
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-dev");
		assert.equal(widgetCalls.length, 1);
	});

	it("no crash when phase is undefined", () => {
		const ctx = createMockCtx();
		const details = makeDetails({ phase: undefined });
		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-dev");
		assert.equal(widgetCalls.length, 1);
	});

	it("passes widgetId verbatim", () => {
		const ctx = createMockCtx();
		const details = makeDetails();
		renderWidgetFromDetails(details, "developer", undefined, ctx, "custom-id-42");
		assert.equal(widgetCalls[0].id, "custom-id-42");
	});

	it("pure function: same input produces same output", () => {
		const ctx1 = createMockCtx();
		const ctx2 = createMockCtx();
		const det = makeDetails({ runningTokenCount: 500 });
		renderWidgetFromDetails(det, "developer", undefined, ctx1, "a");
		renderWidgetFromDetails({ ...det }, "developer", undefined, ctx2, "a");
		assert.deepEqual(widgetCalls[0].lines, widgetCalls[1].lines);
	});

	it("handles all fields provided", () => {
		const ctx = createMockCtx();
		const details = makeDetails({
			runningTokenCount: 50000,
			runningToolCount: 29,
			cacheRead: 2000,
			cacheWrite: 1500,
			errorCount: 2,
			startedAt: Date.now() - 63000,
		});
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx, "agent-dev");
		const line = widgetCalls[0].lines?.[0] ?? "";
		assert.ok(line.includes("subagent:developer"));
		assert.ok(line.includes("claude-sonnet"));
		assert.ok(line.includes("50.0K tokens") || line.includes("50000"));
		assert.ok(line.includes("29 tools"));
		assert.ok(line.includes("📦"));
		assert.ok(line.includes("1m") || line.includes("63") || line.includes("s"));
	});
});
