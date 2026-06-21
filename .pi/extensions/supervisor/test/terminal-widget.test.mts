// ─── Tests: Terminal Widget Rendering — buildWidgetLines() ────────
// Pure function tests for the 6 uncovered categories NOT covered by
// chat-progress.test.mts:
// 2a. Overflow (MAX=10 enforcement)
// 2b. Undefined safety (no "undefined" string)
// 2c. Cache stats footer
// 2d. Truncation direction and boundary
// 2e. JSON parse error for currentToolArgs
// 2f. Idempotency (with injected now)
// + Additional edge cases
//
// Run: node --experimental-strip-types --test .pi/extensions/supervisor/test/terminal-widget.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunState } from "../config/types.ts";
import { buildWidgetLines } from "../session/widget.ts";
import { formatTokens } from "../lib/formatting.ts";

// ─── Helpers ──────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════
// Category 2a: Overflow (MAX_WIDGET_LINES = 10 enforcement)
// ═══════════════════════════════════════════════════════════════════

describe("Overflow — MAX_WIDGET_LINES enforcement", () => {
	it("50 log entries → at most 10 lines, footer is last line", () => {
		const state = createState({
			fullLog: Array.from({ length: 50 }, (_, i) => `Log entry number ${i + 1}`),
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		assert.ok(lines.length <= 10, `Expected ≤10 lines but got ${lines.length}`);
		const lastLine = lines[lines.length - 1];
		assert.ok(lastLine.includes("subagent:"), "Footer should be last line");
	});

	it("entries + liveText + idleWarning consume variable slots, footer survives", () => {
		const state = createState({
			phase: "text",
			liveText: "Generating response...",
			fullLog: Array.from({ length: 10 }, (_, i) => `Entry ${i + 1}`),
		});
		const lines = buildWidgetLines(state, "developer", undefined, "⚠ Idle warning", 10000);
		assert.ok(lines.length <= 10, `Expected ≤10 lines but got ${lines.length}`);
		const lastLine = lines[lines.length - 1];
		assert.ok(
			lastLine.includes("subagent:"),
			"Footer should still be last line with liveText and idleWarning",
		);
	});

	it("0 log entries → no log lines shown, only fixed + footer", () => {
		const state = createState({ fullLog: [] });
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		// fixed: header + context computing... = 2, footer = 1 => 3 lines
		assert.strictEqual(lines.length, 3, "Should have exactly 3 lines (header + context + footer)");
		assert.ok(lines[0].includes("developer"), "First line should be header");
		assert.ok(lines[lines.length - 1].includes("subagent:"), "Last line should be footer");
	});

	it("5 entries fit within MAX with room to spare", () => {
		const state = createState({
			fullLog: Array.from({ length: 5 }, (_, i) => `Entry ${i + 1}`),
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		// fixed (2) + 5 log + footer (1) = 8
		assert.strictEqual(lines.length, 8, "Should have 8 lines (header + context + 5 log + footer)");
		assert.ok(lines[lines.length - 1].includes("subagent:"));
	});
});

// ═══════════════════════════════════════════════════════════════════
// Category 2b: Undefined safety
// ═══════════════════════════════════════════════════════════════════

describe("Undefined safety — no 'undefined' string in output", () => {
	it("all optional fields default/undefined → no 'undefined' substring in any output line", () => {
		// Use default state where all optional fields are undefined and
		// required string fields are empty
		const state = createState({
			phase: "idle",
			contextTokens: undefined,
			contextWindow: undefined,
			currentTool: undefined,
			currentToolArgs: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		for (const line of lines) {
			assert.ok(!line.includes("undefined"), `Line should not contain 'undefined': "${line}"`);
		}
	});

	it('phase="thinking" with empty liveThinking → no 💭 line emitted', () => {
		const state = createState({
			phase: "thinking",
			liveThinking: "",
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const thinkingLine = lines.find((l) => l.includes("💭"));
		assert.equal(
			thinkingLine,
			undefined,
			"Should not emit a thinking line when liveThinking is empty",
		);
	});

	it('phase="text" with empty liveText → no extra live text line', () => {
		const state = createState({
			phase: "text",
			liveText: "",
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		// fixed: header + context = 2, footer = 1 => 3
		assert.strictEqual(lines.length, 3, "Should have 3 lines with empty liveText");
	});

	it("tokenCount=0 → 📊 line omitted from footer", () => {
		const state = createState({
			tokenCount: 0,
			toolCount: 3,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const footer = lines[lines.length - 1];
		assert.ok(!footer.includes("📊"), "Footer should not include token stats when tokenCount is 0");
		assert.ok(footer.includes("🔧"), "Footer should still include tool count");
	});

	it("toolCount=0 → 🔧 line omitted from footer", () => {
		const state = createState({
			toolCount: 0,
			tokenCount: 100,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const footer = lines[lines.length - 1];
		assert.ok(!footer.includes("🔧"), "Footer should not include tool count when toolCount is 0");
		assert.ok(footer.includes("📊"), "Footer should still include token stats");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Category 2c: Cache stats in footer
// ═══════════════════════════════════════════════════════════════════

describe("Cache stats in footer", () => {
	it('cacheRead only → "📦 5.0K/--"', () => {
		const state = createState({
			cacheRead: 5000,
			cacheWrite: undefined,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const footer = lines[lines.length - 1];
		assert.ok(footer.includes("📦 5.0K/--"), `Footer should show 📦 5.0K/-- but got: "${footer}"`);
	});

	it('cacheWrite only → "📦 --/3.0K"', () => {
		const state = createState({
			cacheRead: undefined,
			cacheWrite: 3000,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const footer = lines[lines.length - 1];
		assert.ok(footer.includes("📦 --/3.0K"), `Footer should show 📦 --/3.0K but got: "${footer}"`);
	});

	it('Both cacheRead and cacheWrite → "📦 5.0K/3.0K"', () => {
		const state = createState({
			cacheRead: 5000,
			cacheWrite: 3000,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const footer = lines[lines.length - 1];
		assert.ok(
			footer.includes("📦 5.0K/3.0K"),
			`Footer should show 📦 5.0K/3.0K but got: "${footer}"`,
		);
	});

	it("Both undefined → no 📦 in footer", () => {
		const state = createState({
			cacheRead: undefined,
			cacheWrite: undefined,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const footer = lines[lines.length - 1];
		assert.ok(
			!footer.includes("📦"),
			"Footer should not contain 📦 when both cache stats are undefined",
		);
	});

	it("Cache stats use formatTokens output ('5.0K' not '5000')", () => {
		const state = createState({
			cacheRead: 5000,
			cacheWrite: 3000,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const footer = lines[lines.length - 1];
		// formatTokens(5000) = "5.0K", formatTokens(3000) = "3.0K"
		assert.ok(footer.includes("5.0K"), `Footer should use formatTokens(5000) = "5.0K"`);
		assert.ok(footer.includes("3.0K"), `Footer should use formatTokens(3000) = "3.0K"`);
		// Verify formatTokens directly
		assert.strictEqual(formatTokens(5000), "5.0K");
		assert.strictEqual(formatTokens(3000), "3.0K");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Category 2d: Truncation direction and boundary
// ═══════════════════════════════════════════════════════════════════

describe("Truncation direction and boundary", () => {
	it("liveThinking > 200 chars → shows last 200 chars (most recent)", () => {
		const state = createState({
			phase: "thinking",
			liveThinking: "a".repeat(250),
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const thinkingLine = lines.find((l) => l.includes("💭"));
		assert.ok(thinkingLine, "Should have a thinking line");
		// Extract content after 💭 icon
		const contentAfterIcon = thinkingLine!.slice(thinkingLine!.indexOf("💭") + 2).trim();
		assert.strictEqual(contentAfterIcon.length, 200, "Should show exactly 200 chars of thinking");
		assert.ok(
			contentAfterIcon.endsWith("a".repeat(200)),
			"Should show last 200 chars (most recent)",
		);
	});

	it("log entry > 200 chars → first 197 chars + '...'", () => {
		const state = createState({
			fullLog: ["b".repeat(250)],
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const logLine = lines.find((l) => l.includes("b".repeat(197)));
		assert.ok(logLine, "Log line should start with first 197 chars");
		assert.ok(logLine!.includes("..."), "Log line should end with ellipsis");
		assert.strictEqual(
			logLine!.trim().length,
			200,
			"Truncated log entry should be 200 chars total (197 + 3)",
		);
	});

	it("liveThinking = 200 chars → exact, no truncation", () => {
		const state = createState({
			phase: "thinking",
			liveThinking: "c".repeat(200),
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const thinkingLine = lines.find((l) => l.includes("💭"));
		assert.ok(thinkingLine, "Should have a thinking line");
		const contentAfterIcon = thinkingLine!.slice(thinkingLine!.indexOf("💭") + 2).trim();
		assert.strictEqual(contentAfterIcon.length, 200, "Should show all 200 chars exactly");
		assert.ok(!contentAfterIcon.includes("..."), "Should not have ellipsis");
	});

	it("log entry = 200 chars → exact, no truncation", () => {
		const state = createState({
			fullLog: ["d".repeat(200)],
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const logLine = lines.find((l) => l.includes("d".repeat(200)));
		assert.ok(logLine, "Log line should show all 200 chars");
		assert.ok(!logLine!.includes("..."), "Should not have ellipsis");
	});

	it("log entry = 197 chars → no ellipsis", () => {
		const state = createState({
			fullLog: ["e".repeat(197)],
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const logLine = lines.find((l) => l.includes("e".repeat(197)));
		assert.ok(logLine, "Log line should show all 197 chars");
		assert.ok(!logLine!.includes("..."), "Should not have ellipsis for exactly 197 chars");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Category 2e: JSON parse error for currentToolArgs
// ═══════════════════════════════════════════════════════════════════

describe("JSON parse error for currentToolArgs", () => {
	it('currentToolArgs = "not-json" → no crash, tool name rendered without args', () => {
		const state = createState({
			currentTool: "bash",
			currentToolArgs: "not-json",
		});
		// Must not throw
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const toolLine = lines.find((l) => l.includes("🔧"));
		assert.ok(toolLine, "Should have a tool line");
		// formatToolCall with undefined/null args for bash returns "$"
		assert.ok(toolLine!.includes("$"), "Tool line should show bash format without args");
	});

	it("currentToolArgs = undefined → no crash, tool name rendered without args", () => {
		const state = createState({
			currentTool: "bash",
			currentToolArgs: undefined,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const toolLine = lines.find((l) => l.includes("🔧"));
		assert.ok(toolLine, "Should have a tool line");
		assert.ok(toolLine!.includes("$"), "Tool line should show bash format");
	});

	it("currentToolArgs = valid JSON → args rendered", () => {
		const state = createState({
			currentTool: "bash",
			currentToolArgs: '{"command": "echo hi"}',
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const toolLine = lines.find((l) => l.includes("🔧"));
		assert.ok(toolLine, "Should have a tool line");
		assert.ok(toolLine!.includes("$ echo hi"), "Tool line should show formatted command");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Category 2f: Idempotency (with injected now)
// ═══════════════════════════════════════════════════════════════════

describe("Idempotency — with injected now", () => {
	it("Same input + same now → identical output (deep equality)", () => {
		const state = createState({
			phase: "thinking",
			liveThinking: "Thinking about tests...",
			currentTool: "bash",
			currentToolArgs: '{"command": "ls"}',
			tokenCount: 500,
			toolCount: 3,
			startedAt: 0,
		});
		const result1 = buildWidgetLines(state, "developer", "claude-sonnet-4", undefined, 5000);
		const result2 = buildWidgetLines(state, "developer", "claude-sonnet-4", undefined, 5000);
		assert.deepEqual(
			result1,
			result2,
			"Two calls with same input + same now should produce identical output",
		);
	});

	it("Three calls with same input + same now → all identical", () => {
		const state = createState({
			phase: "tool",
			currentTool: "read",
			currentToolArgs: '{"path": "/tmp/test"}',
			tokenCount: 200,
			toolCount: 1,
			startedAt: 1000,
		});
		const r1 = buildWidgetLines(state, "dev", "model", undefined, 10000);
		const r2 = buildWidgetLines(state, "dev", "model", undefined, 10000);
		const r3 = buildWidgetLines(state, "dev", "model", undefined, 10000);
		assert.deepEqual(r1, r2);
		assert.deepEqual(r2, r3);
	});

	it("Different now → only footer duration differs, all other lines identical", () => {
		const state = createState({
			tokenCount: 100,
			toolCount: 2,
			startedAt: 0,
		});
		const resultEarly = buildWidgetLines(state, "developer", "model", undefined, 5000);
		const resultLate = buildWidgetLines(state, "developer", "model", undefined, 30000);

		// All lines except the last (footer) should be identical
		for (let i = 0; i < resultEarly.length - 1; i++) {
			assert.strictEqual(
				resultEarly[i],
				resultLate[i],
				`Line ${i} should be identical regardless of now`,
			);
		}
		// Footers should differ in duration
		assert.notStrictEqual(resultEarly[resultEarly.length - 1], resultLate[resultLate.length - 1]);
		assert.ok(
			resultEarly[resultEarly.length - 1].includes("5s"),
			"Early footer duration should be 5s",
		);
		assert.ok(
			resultLate[resultLate.length - 1].includes("30s"),
			"Late footer duration should be 30s",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Additional edge cases
// ═══════════════════════════════════════════════════════════════════

describe("Additional edge cases", () => {
	it("Model short name extraction (last segment after /)", () => {
		const state = createState();
		const lines = buildWidgetLines(state, "dev", "anthropic/claude-sonnet-4", undefined, 10000);
		const footer = lines[lines.length - 1];
		assert.ok(
			footer.includes("🧠 claude-sonnet-4"),
			`Footer should show short model name 'claude-sonnet-4' but got: "${footer}"`,
		);
	});

	it("Model without / → full model name shown", () => {
		const state = createState();
		const lines = buildWidgetLines(state, "dev", "deepseek-v4", undefined, 10000);
		const footer = lines[lines.length - 1];
		assert.ok(
			footer.includes("🧠 deepseek-v4"),
			`Footer should show full model name 'deepseek-v4' but got: "${footer}"`,
		);
	});

	it("Model undefined → no 🧠 in footer", () => {
		const state = createState();
		const lines = buildWidgetLines(state, "dev", undefined, undefined, 10000);
		const footer = lines[lines.length - 1];
		assert.ok(!footer.includes("🧠"), "Footer should not contain 🧠 when model is undefined");
	});

	it("Context info received with zero tokens", () => {
		const state = createState({
			contextInfoReceived: true,
			contextTokens: 0,
			contextWindow: 16000,
		});
		const lines = buildWidgetLines(state, "developer", undefined, undefined, 10000);
		const contextLine = lines.find((l) => l.includes("Context:"));
		assert.ok(contextLine, "Should have a context line");
		// formatTokens(0) = "0", formatTokens(16000) = "16.0K"
		assert.ok(
			contextLine!.includes("0/16.0K"),
			`Context line should show '0/16.0K' but got: "${contextLine}"`,
		);
	});

	it("Mixed overflow + liveText + idleWarning → at most 10 lines, footer last", () => {
		const state = createState({
			phase: "text",
			liveText: "Processing results...",
			fullLog: Array.from({ length: 12 }, (_, i) => `Log line ${i + 1}`),
		});
		const lines = buildWidgetLines(state, "developer", undefined, "⚠ Slow agent", 10000);
		assert.ok(lines.length <= 10, `Should be at most 10 lines but got ${lines.length}`);
		const lastLine = lines[lines.length - 1];
		assert.ok(lastLine.includes("subagent:"), "Footer should be last line");
		// Verify most recent log entries are shown (not the first ones)
		assert.ok(
			lines.some((l) => l.includes("Log line 12")),
			"Should show the most recent log entry",
		);
		assert.ok(
			lines.some((l) => l.includes("Log line 8")),
			"Should show entry 8 (among the most recent)",
		);
	});
});
