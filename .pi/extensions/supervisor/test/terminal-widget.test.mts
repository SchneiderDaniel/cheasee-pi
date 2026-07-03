// ─── Tests: Terminal Widget Rendering — buildWidgetLines() ────────
// Widget now shows ONLY the stats footer line (no headers, logs, tools).
//
// Run: node --experimental-strip-types --test .pi/extensions/supervisor/test/terminal-widget.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunState } from "../config/types.ts";
import { buildWidgetLines } from "../session/widget.ts";

function createState(overrides?: Partial<AgentRunState>): AgentRunState {
	return {
		phase: "idle",
		startedAt: 0,
		tokenCount: 0,
		toolCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		lastToolName: undefined,
		contextTokens: undefined,
		contextWindow: undefined,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		failedToolCount: 0,
		cacheRead: undefined,
		cacheWrite: undefined,
		...overrides,
	};
}

describe("Simplified widget — footer only", () => {
	it("returns exactly one line", () => {
		const state = createState();
		const lines = buildWidgetLines(state, "developer", undefined, 10000);
		assert.strictEqual(lines.length, 1, "should return exactly 1 line");
	});

	it("contains subagent:agentName prefix", () => {
		const lines = buildWidgetLines(createState(), "architect", undefined, 10000);
		assert.ok(lines[0].includes("subagent:architect"));
	});

	it("includes model when provided", () => {
		const lines = buildWidgetLines(createState(), "dev", "claude-sonnet-4", 10000);
		assert.ok(lines[0].includes("claude-sonnet-4"));
	});

	it("uses short model name (strips path prefix)", () => {
		const lines = buildWidgetLines(
			createState(),
			"dev",
			"anthropic/claude-sonnet-4",
			10000,
		);
		assert.ok(lines[0].includes("claude-sonnet-4"));
		assert.ok(!lines[0].includes("anthropic"));
	});

	it("includes token count when > 0", () => {
		const state = createState({ tokenCount: 1500 });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(lines[0].includes("1.5K tokens"));
	});

	it("omits token count when 0", () => {
		const state = createState({ tokenCount: 0 });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(!lines[0].includes("tokens"));
	});

	it("includes tool count when > 0", () => {
		const state = createState({ toolCount: 5 });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(lines[0].includes("5 tools"));
	});

	it("omits tool count when 0", () => {
		const state = createState({ toolCount: 0 });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(!lines[0].includes("tools"));
	});

	it("includes duration", () => {
		const lines = buildWidgetLines(createState(), "dev", undefined, 10000);
		assert.ok(lines[0].includes("10s"));
	});

	it("includes cache stats when cacheRead/cacheWrite > 0", () => {
		const state = createState({ cacheRead: 1000, cacheWrite: 500 });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(lines[0].includes("📦"));
		assert.ok(lines[0].includes("1.0K/500") || lines[0].includes("1000/500"));
	});

	it("omits cache stats when cacheRead/cacheWrite are 0", () => {
		const state = createState({ cacheRead: 0, cacheWrite: 0 });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(!lines[0].includes("📦"));
	});

	it("omits cache stats when cacheRead/cacheWrite are undefined", () => {
		const state = createState({ cacheRead: undefined, cacheWrite: undefined });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(!lines[0].includes("📦"));
	});

	it("ignores fullLog entries (no log section shown)", () => {
		const state = createState({ fullLog: ["entry1", "entry2", "entry3"] });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.strictEqual(lines.length, 1, "only 1 line regardless of log entries");
		assert.ok(!lines[0].includes("entry1"), "log entries not shown");
	});

	it("ignores phase, liveThinking, currentTool, liveText", () => {
		const state = createState({
			phase: "thinking",
			liveThinking: "deep thoughts",
			currentTool: "bash",
			currentToolArgs: '{"command":"ls"}',
			liveText: "live output",
		});
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.strictEqual(lines.length, 1);
		assert.ok(!lines[0].includes("deep"), "no thinking shown");
		assert.ok(!lines[0].includes("bash"), "no tool shown");
		assert.ok(!lines[0].includes("live output"), "no live text shown");
	});

	it("ignores idleWarning", () => {
		const state = createState();
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.strictEqual(lines.length, 1);
		assert.ok(!lines[0].includes("Idle"), "no idle warning shown");
	});

	it("uses the provided `now` timestamp for duration calculation", () => {
		const state = createState({ startedAt: 5000 }); // started at 5s
		const lines = buildWidgetLines(state, "dev", undefined, 10000); // now = 10s
		// 10000 - 5000 = 5000ms = 5s
		assert.ok(lines[0].includes("5s"), `expected 5s duration, got: ${lines[0]}`);
	});

	it("idempotent: same input produces same output", () => {
		const state = createState({ tokenCount: 100, toolCount: 3 });
		const a = buildWidgetLines(state, "dev", "m", 10000);
		const b = buildWidgetLines(state, "dev", "m", 10000);
		assert.deepEqual(a, b);
	});

	it("all stats populated simultaneously", () => {
		const state = createState({
			tokenCount: 50000,
			toolCount: 29,
			cacheRead: 2000,
			cacheWrite: 1500,
			startedAt: 0,
		});
		const lines = buildWidgetLines(state, "developer", "deepseek-v4-flash", 63000);
		const line = lines[0];
		assert.ok(line.includes("subagent:developer"));
		assert.ok(line.includes("deepseek-v4-flash"));
		assert.ok(line.includes("50.0K tokens") || line.includes("50000 tokens"));
		assert.ok(line.includes("29 tools"));
		assert.ok(line.includes("📦"));
		assert.ok(line.includes("1m 3s") || line.includes("63s"));
	});

	it("no 'undefined' string appears in output", () => {
		const state = createState({
			cacheRead: undefined,
			cacheWrite: undefined,
		});
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(!lines[0].includes("undefined"), "no 'undefined' in output");
	});

	it("includes thinking level icon and name when state has thinkingLevel", () => {
		const state = createState({ thinkingLevel: "medium" });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(lines[0].includes("◒ medium"), "should show '◒ medium' for medium thinking");
	});

	it("omits thinking level when state.thinkingLevel is undefined", () => {
		const state = createState();
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(!lines[0].includes("◒"), "should not show thinking icon when undefined");
		assert.ok(!lines[0].includes("medium"), "should not show thinking name when undefined");
	});

	it("omits thinking level for unknown level string", () => {
		const state = createState({ thinkingLevel: "bogus" });
		const lines = buildWidgetLines(state, "dev", undefined, 10000);
		assert.ok(!lines[0].includes("bogus"), "should not show unknown thinking level");
	});

	it("thinking level appears after model in stats line", () => {
		const state = createState({ thinkingLevel: "high", tokenCount: 1000, toolCount: 3, cacheRead: 0, cacheWrite: 0, startedAt: 0 });
		const lines = buildWidgetLines(state, "dev", "some-model", 10000);
		const line = lines[0];
		const modelIdx = line.indexOf("some-model");
		const thinkingIdx = line.indexOf("◓");
		assert.ok(modelIdx >= 0, "should have model");
		assert.ok(thinkingIdx >= 0, "should have thinking icon");
		assert.ok(thinkingIdx > modelIdx, "thinking level should appear after model");
	});

	it("all levels render correct icon", () => {
		const iconMap: Record<string, string> = { off: "○", minimal: "◐", low: "◑", medium: "◒", high: "◓", xhigh: "●" };
		for (const [level, icon] of Object.entries(iconMap)) {
			const state = createState({ thinkingLevel: level });
			const lines = buildWidgetLines(state, "dev", undefined, 10000);
			assert.ok(lines[0].includes(icon), `level '${level}' should show icon '${icon}'`);
			assert.ok(lines[0].includes(level), `level '${level}' should show name`);
		}
	});
});
