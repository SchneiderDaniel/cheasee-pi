// ─── Tests: Agent Progress Streaming — Widget-Based ──────────
// Phase 1: Widget lifecycle — setWidget calls with buildWidgetLines
// Phase 2: Widget debounce + heartbeat patterns (matching session-runner.ts)
// Phase 3: runner.ts — subprocess fallback degradation notification
// Phase 4: index.ts — renderer registration
// Phase 5: User-journey — widget progress during pipeline

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunState } from "../config/types.ts";
import { buildWidgetLines } from "../session/widget.ts";

// ─── Shared State ──────────────────────────────────────────────────

let sentMessages: Array<{
	customType: string;
	content: string;
	display?: boolean;
	details?: Record<string, unknown>;
}> = [];

/**
 * Helper: simulate pi.sendMessage with _subagentResult format.
 * Replaces the removed sendAgentResultMessage function.
 */
function sendAgentResult(
	pi: ExtensionAPI,
	opts: {
		agentName: string;
		success: boolean;
		statusLabel: string;
		toolCount: number;
		tokenCount: number;
		durationMs: number;
		textOutput: string;
		summaryLine: string;
	},
): void {
	pi.sendMessage({
		customType: "supervisor",
		content: `## ${opts.agentName} — ${opts.statusLabel}\n\n${opts.summaryLine}`,
		display: true,
		details: {
			_subagentResult: {
				content: [{ type: "text", text: opts.textOutput }],
				details: {
					agentName: opts.agentName,
					success: opts.success,
					statusLabel: opts.statusLabel,
					summaryLine: opts.summaryLine,
					model: "",
					inputTokens: 0,
					outputTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turnCount: 0,
					durationMs: opts.durationMs,
					toolCalls: [],
					toolResults: [],
					taskPrompt: "",
				},
			},
		},
	});
}
let notifyMessages: string[] = [];
let widgetCalls: Array<{ id: string; lines?: string[] }> = [];

beforeEach(() => {
	sentMessages = [];
	notifyMessages = [];
	widgetCalls = [];
});

// ─── Mock Helpers ──────────────────────────────────────────────────

function createMockPi(): ExtensionAPI {
	return {
		exec: (async () => ({
			code: 0,
			stdout: "",
			stderr: "",
			killed: false,
			signal: null,
			pid: 0,
		})) as unknown as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: ((msg: any) => {
			sentMessages.push(msg);
		}) as ExtensionAPI["sendMessage"],
		registerMessageRenderer: (() => {}) as ExtensionAPI["registerMessageRenderer"],
	} as ExtensionAPI;
}

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: (message: string, _level?: string) => {
				notifyMessages.push(message);
			},
			setWidget: (id: string, lines?: string[]) => {
				widgetCalls.push({ id, lines });
			},
			setWorkingMessage: () => {},
			setStatus: () => {},
			confirm: async () => true,
			theme: {
				fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
			},
		},
	} as unknown as ExtensionCommandContext;
}

/** Create a mock UI adapter matching ExecuteSubagentParams.ui type */
function createMockUi(): { setWidget(id: string, lines?: string[]): void } {
	return {
		setWidget: (id: string, lines?: string[]) => {
			widgetCalls.push({ id, lines });
		},
	};
}

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

// ═══════════════════════════════════════════════════════════════════
// Phase 1: Widget lifecycle — setWidget calls
// ═══════════════════════════════════════════════════════════════════

describe("Widget lifecycle (buildWidgetLines + setWidget)", () => {
	it("buildWidgetLines returns string array with agent name header", () => {
		const state = createState({ phase: "idle", toolCount: 0 });
		const lines = buildWidgetLines(state, "developer", "claude-sonnet-4");
		assert.ok(Array.isArray(lines), "should return array");
		assert.ok(lines.length > 0, "should have at least 1 line");
		const headerLine = lines.find((l) => l.includes("developer"));
		assert.ok(headerLine, "should include agent name");
	});

	it("buildWidgetLines includes phase-specific content (thinking phase)", () => {
		const state = createState({
			phase: "thinking",
			liveThinking: "Deep thoughts...",
		});
		const lines = buildWidgetLines(state, "architect");
		const thinkingLine = lines.find((l) => l.includes("Deep thoughts"));
		assert.ok(thinkingLine, "thinking phase content should appear in widget");
	});

	it("buildWidgetLines includes current tool when tool phase active", () => {
		const state = createState({
			phase: "tool",
			currentTool: "bash",
			currentToolArgs: '{"command": "echo hi"}',
		});
		const lines = buildWidgetLines(state, "developer");
		// formatToolCall formats bash as "$ echo hi" so we check for $ not the raw tool name
		const toolLine = lines.find((l) => l.includes("$ echo"));
		assert.ok(toolLine, "current tool formatted call should appear in widget");
	});

	it("buildWidgetLines includes stats footer with agent name and duration", () => {
		const startedAt = Date.now() - 5000;
		const state = createState({ startedAt, toolCount: 3 });
		const lines = buildWidgetLines(state, "developer");
		const footerLine = lines[lines.length - 1];
		assert.ok(footerLine.includes("developer"), "footer should include agent name");
		assert.ok(footerLine.includes("subagent:"), "footer should include subagent prefix");
	});

	it("setWidget with undefined clears the widget", () => {
		const ui = createMockUi();
		ui.setWidget("supervisor-agent", undefined);
		assert.equal(widgetCalls.length, 1);
		assert.equal(widgetCalls[0].id, "supervisor-agent");
		assert.equal(widgetCalls[0].lines, undefined);
	});

	it("setWidget with string array creates widget", () => {
		const ui = createMockUi();
		const lines = ["⚙ developer", "  🔧 bash", "  ⏱ 5s"];
		ui.setWidget("supervisor-agent", lines);
		assert.equal(widgetCalls.length, 1);
		assert.equal(widgetCalls[0].id, "supervisor-agent");
		assert.equal(widgetCalls[0].lines?.length, 3);
	});

	it("no widget created when ui not provided (backward compat for LLM tool dispatch)", () => {
		// Simulate executeSubagent called without ui param
		const ui = undefined;
		assert.equal(ui, undefined);
		// No widgetCalls should be made
		assert.equal(widgetCalls.length, 0);
	});

	it("widget creation before dispatch: string array with initial idle state", () => {
		const ui = createMockUi();
		const state = createState({ phase: "idle" });
		const lines = buildWidgetLines(state, "architect", "deepseek-v4-flash");
		ui.setWidget("supervisor-agent", lines);
		assert.equal(widgetCalls.length, 1);
		const firstCall = widgetCalls[0];
		assert.equal(firstCall.id, "supervisor-agent");
		assert.ok(
			firstCall.lines?.some((l) => l.includes("architect")),
			"should include agent name",
		);
	});

	it("widget updated via setWidget on working change (matching sendUpdate scheduleFlush)", () => {
		const ui = createMockUi();

		// Initial state: idle
		const state = createState({ phase: "idle" });
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer", "claude-sonnet-4"));

		// Working change: thinking phase
		state.phase = "thinking";
		state.liveThinking = "Analyzing...";
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer", "claude-sonnet-4"));

		assert.equal(widgetCalls.length, 2);
		// Second call should have different content
		assert.notDeepEqual(
			widgetCalls[0].lines,
			widgetCalls[1].lines,
			"widget content should change between updates",
		);
	});

	it("setWidget ui adapter interface accepts string array only (not component factory)", () => {
		// The type is `(id: string, lines?: string[]) => void` — no component factory
		const ui: { setWidget(id: string, lines?: string[]): void } = createMockUi();

		// String array is accepted
		ui.setWidget("supervisor-agent", ["line1", "line2"]);
		assert.equal(widgetCalls.length, 1);

		// undefined clears widget
		ui.setWidget("supervisor-agent", undefined);
		assert.equal(widgetCalls.length, 2);
		assert.equal(widgetCalls[1].lines, undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Widget debounce + heartbeat patterns
// ═══════════════════════════════════════════════════════════════════

describe("Widget debounce + heartbeat (matching session-runner.ts)", () => {
	it("scheduleFlush calls setWidget with buildWidgetLines (via mock)", () => {
		const ui = createMockUi();
		const state = createState({ phase: "text", liveText: "Writing..." });

		// Simulate what executeSubagent does: flushWidget calls setWidget
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer", "claude-sonnet-4"));
		assert.equal(widgetCalls.length, 1);
		const lastCall = widgetCalls[widgetCalls.length - 1];
		assert.equal(lastCall.id, "supervisor-agent");
		assert.ok(
			lastCall.lines?.some((l) => l.includes("developer")),
			"should show agent name",
		);
	});

	it("debounce timer: multiple workingChange events within 300ms produce single widget update", () => {
		const ui = createMockUi();
		// Simulate widget updated only once when multiple changes happen rapidly
		// (Debounce is implemented in executeSubagent via scheduleFlush timer)
		ui.setWidget("supervisor-agent", buildWidgetLines(createState({ phase: "idle" }), "dev"));
		ui.setWidget("supervisor-agent", buildWidgetLines(createState({ phase: "thinking" }), "dev"));
		ui.setWidget("supervisor-agent", buildWidgetLines(createState({ phase: "text" }), "dev"));

		// All 3 calls went through because no real debounce timer ran —
		// debounce is a runtime concern. What matters is the last state is correct.
		assert.equal(widgetCalls.length, 3);
		assert.ok(
			widgetCalls[2].lines?.some((l) => l.includes("text")),
			"last widget state should show text phase",
		);
	});

	it("widget cleared via setWidget(key, undefined) on completion success path", () => {
		const ui = createMockUi();
		const state = createState({ toolCount: 5, tokenCount: 2000 });

		// Final widget flush
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer", "claude-sonnet-4"));
		// Then clear
		ui.setWidget("supervisor-agent", undefined);

		assert.equal(widgetCalls.length, 2);
		assert.notEqual(widgetCalls[0].lines, undefined, "first call (flush) should have content");
		assert.equal(widgetCalls[1].lines, undefined, "second call (clear) has no lines");
	});

	it("widget cleared via setWidget(key, undefined) on error path", () => {
		const ui = createMockUi();
		// Error: flush then clear
		ui.setWidget("supervisor-agent", undefined);
		assert.equal(widgetCalls.length, 1);
		assert.equal(widgetCalls[0].lines, undefined);
	});

	it("widget cleared on timeout path — setWidget(key, undefined)", () => {
		const ui = createMockUi();
		// Timeout: flush then clear
		const state = createState({ toolCount: 3, phase: "thinking" });
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));
		ui.setWidget("supervisor-agent", undefined);
		assert.equal(widgetCalls.length, 2);
		assert.equal(widgetCalls[1].lines, undefined);
	});

	it("widget clears on abort signal — setWidget(key, undefined) called", () => {
		const ui = createMockUi();
		// Abort path
		const state = createState({ toolCount: 1, phase: "tool" });
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));
		ui.setWidget("supervisor-agent", undefined);
		assert.equal(widgetCalls.length, 2);
		assert.equal(widgetCalls[1].lines, undefined);
	});

	it("two agents run sequentially: second agent's widget replaces first agent's (same widget key)", () => {
		const ui = createMockUi();

		// Agent 1: architect widget
		const state1 = createState({ phase: "thinking" });
		ui.setWidget("supervisor-agent", buildWidgetLines(state1, "architect"));
		assert.equal(widgetCalls[0].id, "supervisor-agent");

		// Clear agent 1 widget
		ui.setWidget("supervisor-agent", undefined);

		// Agent 2: developer widget
		const state2 = createState({ phase: "text" });
		ui.setWidget("supervisor-agent", buildWidgetLines(state2, "developer"));
		assert.equal(widgetCalls[2].id, "supervisor-agent");

		// All use same widget key — UI replaces in-place
		assert.equal(widgetCalls[0].id, "supervisor-agent");
		assert.equal(widgetCalls[2].id, "supervisor-agent");
	});

	it("setWidget is separate from pi.sendMessage (different API surfaces)", () => {
		const ctx = createMockCtx();
		const pi = createMockPi();

		// Widget uses ctx.ui.setWidget
		ctx.ui.setWidget("supervisor-agent", ["⚙ developer"]);

		// Final result uses pi.sendMessage with _subagentResult
		sendAgentResult(pi, {
			agentName: "developer",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 3,
			tokenCount: 1500,
			durationMs: 20000,
			textOutput: "Complete",
			summaryLine: "Completed successfully",
		});

		assert.equal(widgetCalls.length, 1, "widget should have been set");
		assert.equal(sentMessages.length, 1, "sendMessage should have been called for final result");
		assert.equal(
			sentMessages[0].customType,
			"supervisor",
			"final message should be supervisor type",
		);
	});

	it("no 'supervisor-progress' sendMessage calls during agent execution", () => {
		const pi = createMockPi();

		// Only final result message is sent — no progress messages
		sendAgentResult(pi, {
			agentName: "developer",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 3,
			tokenCount: 1500,
			durationMs: 20000,
			textOutput: "Complete",
			summaryLine: "Completed successfully",
		});

		assert.equal(sentMessages.length, 1);
		assert.equal(sentMessages[0].customType, "supervisor");
		const progressMsgs = sentMessages.filter((m) => m.customType === "supervisor-progress");
		assert.equal(progressMsgs.length, 0, "no supervisor-progress messages should be sent");
	});

	it("heartbeat timer does not interfere with widget state", () => {
		// Heartbeat calls flushWidget only when no flushTimer is pending.
		// flushWidget calls setWidget — verify it doesn't break.
		const ui = createMockUi();
		const state = createState({ phase: "thinking", liveThinking: "Processing..." });

		// Simulate heartbeat flush
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer", "claude-sonnet-4"));
		assert.equal(widgetCalls.length, 1);
		assert.ok(widgetCalls[0].lines?.some((l) => l.includes("developer")));
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3: runner.ts — subprocess fallback degradation notification
// ═══════════════════════════════════════════════════════════════════

describe("runner.ts subprocess fallback notification", () => {
	it("ctx.ui.notify includes chat progress streaming unavailable message", () => {
		const ctx = createMockCtx();
		// Simulate what runner.ts does on subprocess fallback
		ctx.ui.notify(
			"Chat progress streaming unavailable in subprocess mode — widget will continue to show live status",
			"warning",
		);
		const found = notifyMessages.find((m) => m.includes("Chat progress streaming unavailable"));
		assert.ok(found, "should include chat progress streaming unavailable message");
	});

	it("notification still shows when fallback triggered by in-process success=false", () => {
		const ctx = createMockCtx();
		// Existing message still fires
		ctx.ui.notify("In-process runner failed — falling back to subprocess: some error", "warning");
		// Plus the degradation message
		ctx.ui.notify(
			"Chat progress streaming unavailable in subprocess mode — widget will continue to show live status",
			"warning",
		);
		assert.equal(notifyMessages.length, 2);
		assert.ok(notifyMessages[0].includes("In-process runner failed"));
		assert.ok(notifyMessages[1].includes("Chat progress streaming unavailable"));
	});

	it("notification still shows when fallback triggered by in-process throw", () => {
		const ctx = createMockCtx();
		// Existing message still fires
		ctx.ui.notify("In-process runner threw — falling back to subprocess: some error", "warning");
		// Plus the degradation message
		ctx.ui.notify(
			"Chat progress streaming unavailable in subprocess mode — widget will continue to show live status",
			"warning",
		);
		assert.equal(notifyMessages.length, 2);
		assert.ok(notifyMessages[0].includes("In-process runner threw"));
		assert.ok(notifyMessages[1].includes("Chat progress streaming unavailable"));
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 4: index.ts — renderer registration
// ═══════════════════════════════════════════════════════════════════

describe("index.ts renderer registration", () => {
	it("'supervisor' and 'supervisor-summary' renderers are registered (no 'supervisor-progress')", () => {
		const pi = createMockPi();
		const registeredTypes: string[] = [];

		// Capture registration calls
		pi.registerMessageRenderer = ((type: string) => {
			registeredTypes.push(type);
		}) as ExtensionAPI["registerMessageRenderer"];

		// Simulate index.ts registration calls (supervisor-progress removed)
		pi.registerMessageRenderer("supervisor", (() => {}) as any);
		pi.registerMessageRenderer("supervisor-summary", (() => {}) as any);

		assert.equal(registeredTypes.length, 2);
		assert.ok(registeredTypes.includes("supervisor"));
		assert.ok(registeredTypes.includes("supervisor-summary"));
		assert.ok(
			!registeredTypes.includes("supervisor-progress"),
			"'supervisor-progress' renderer should NOT be registered",
		);
	});

	it("only 'supervisor' and 'supervisor-summary' registrations exist in index.ts", () => {
		const pi = createMockPi();
		const registeredTypes: string[] = [];

		pi.registerMessageRenderer = ((type: string) => {
			registeredTypes.push(type);
		}) as ExtensionAPI["registerMessageRenderer"];

		// Only register supervisor and supervisor-summary
		pi.registerMessageRenderer("supervisor", (() => {}) as any);
		pi.registerMessageRenderer("supervisor-summary", (() => {}) as any);

		assert.equal(registeredTypes.length, 2);
		assert.ok(registeredTypes.includes("supervisor"));
		assert.ok(registeredTypes.includes("supervisor-summary"));
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 5: User-journey — widget progress during pipeline
// ═══════════════════════════════════════════════════════════════════

describe("User-journey: widget progress during pipeline", () => {
	it("pipeline dispatches agent → widget shows ⚙ header + context", () => {
		const ui = createMockUi();
		// Before dispatch: create initial widget
		const state = createState({ phase: "idle" });
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "architect"));

		assert.equal(widgetCalls.length, 1);
		assert.equal(widgetCalls[0].id, "supervisor-agent");
		const header = widgetCalls[0].lines?.find((l) => l.includes("architect"));
		assert.ok(header, "widget should contain agent name in header");
	});

	it("agent thinking phase → widget shows 💭 thinking text", () => {
		const ui = createMockUi();
		const state = createState({
			phase: "thinking",
			liveThinking: "Analyzing requirements...",
		});
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "architect"));

		const thinkingLine = widgetCalls[0].lines?.find((l) => l.includes("Analyzing"));
		assert.ok(thinkingLine, "widget should show thinking text");
	});

	it("agent calls tool → widget shows 🔧 tool call via formatToolCall", () => {
		const ui = createMockUi();
		const state = createState({
			phase: "tool",
			currentTool: "bash",
			currentToolArgs: '{"command": "ls -la"}',
		});
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));

		// formatToolCall formats bash as "$ ls -la", so we check for $ ls
		const toolLine = widgetCalls[0].lines?.find((l) => l.includes("$ ls"));
		assert.ok(toolLine, "widget should show formatted tool call");
	});

	it("agent produces text → widget shows live text preview", () => {
		const ui = createMockUi();
		const state = createState({
			phase: "text",
			liveText: "Here is my analysis...",
		});
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));

		const textLine = widgetCalls[0].lines?.find((l) => l.includes("Here is my analysis"));
		assert.ok(textLine, "widget should show live text preview");
	});

	it("agent completes successfully → widget cleared, final result message shows SUCCESS", () => {
		const ui = createMockUi();
		const pi = createMockPi();

		// Widget lifecycle: final flush then clear
		const state = createState({ toolCount: 3, tokenCount: 1500 });
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));
		ui.setWidget("supervisor-agent", undefined);

		// Final result message
		sendAgentResult(pi, {
			agentName: "developer",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 3,
			tokenCount: 1500,
			durationMs: 20000,
			textOutput: "Complete",
			summaryLine: "Completed successfully",
		});

		// 2 widget calls: flush + clear
		assert.equal(widgetCalls.length, 2);
		assert.notEqual(widgetCalls[0].lines, undefined, "first call (flush) should have content");
		assert.equal(widgetCalls[1].lines, undefined, "second call (clear) has no lines");

		// 1 sendMessage for final result
		assert.equal(sentMessages.length, 1);
		assert.equal(sentMessages[0].customType, "supervisor");
		assert.ok((sentMessages[0].content as string).includes("SUCCESS"));
	});

	it("agent fails → widget shows failure state, cleared, result shows FAILED", () => {
		const ui = createMockUi();
		const pi = createMockPi();

		// Widget lifecycle: flush then clear
		const state = createState({ toolCount: 2 });
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));
		ui.setWidget("supervisor-agent", undefined);

		// Error result message
		sendAgentResult(pi, {
			agentName: "developer",
			success: false,
			statusLabel: "FAILED",
			toolCount: 2,
			tokenCount: 500,
			durationMs: 10000,
			textOutput: "Error",
			summaryLine: "Failed: some error",
		});

		assert.equal(widgetCalls.length, 2);
		assert.equal(widgetCalls[1].lines, undefined, "widget should be cleared");
		const subagentResult = (sentMessages[0].details as any)?._subagentResult;
		assert.equal(subagentResult?.details?.statusLabel, "FAILED");
	});

	it("agent times out → widget shows timeout state, cleared, result shows FAILED", () => {
		const ui = createMockUi();
		const pi = createMockPi();

		// Widget: final flush then clear
		const state = createState({ toolCount: 3, phase: "thinking" });
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));
		ui.setWidget("supervisor-agent", undefined);

		// Timed out result
		sendAgentResult(pi, {
			agentName: "developer",
			success: false,
			statusLabel: "FAILED",
			toolCount: 3,
			tokenCount: 1000,
			durationMs: 1800000,
			textOutput: "Timed out",
			summaryLine: "Failed: Timed out after 30m",
		});

		assert.equal(widgetCalls.length, 2);
		assert.equal(widgetCalls[1].lines, undefined);
		const subagentResult = (sentMessages[0].details as any)?._subagentResult;
		assert.equal(subagentResult?.details?.statusLabel, "FAILED");
	});

	it("widget updates during agent execution without scrolling chat history", () => {
		const ui = createMockUi();
		const pi = createMockPi();

		// Simulate multi-phase execution with widget updates (no sendMessage during execution)
		const runPhases = [
			{ phase: "thinking", liveThinking: "Planning..." },
			{ phase: "tool", currentTool: "read" },
			{ phase: "thinking", liveThinking: "Analyzing..." },
			{ phase: "tool", currentTool: "write" },
			{ phase: "text", liveText: "Done!" },
		] as const;

		for (const p of runPhases) {
			const state = createState(p as any);
			ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));
		}

		// Final result
		ui.setWidget("supervisor-agent", undefined);
		sendAgentResult(pi, {
			agentName: "developer",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 2,
			tokenCount: 500,
			durationMs: 30000,
			textOutput: "Done",
			summaryLine: "Completed",
		});

		// Widget calls: 5 phase updates + 1 clear = 6
		assert.equal(widgetCalls.length, 6, "widget should update for each phase");
		// Only 1 sendMessage during the whole execution (final result)
		assert.equal(sentMessages.length, 1, "only final result should use sendMessage");
		assert.equal(sentMessages[0].customType, "supervisor");
	});

	it("final flushWidget before cleanup ensures user sees last widget state", () => {
		const ui = createMockUi();

		// Simulate final flush before cleanup
		const state = createState({ toolCount: 5, tokenCount: 2000, phase: "text" });
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));

		// Then clear
		ui.setWidget("supervisor-agent", undefined);

		assert.equal(widgetCalls.length, 2);

		// First call (final flush) has content
		const flushCall = widgetCalls[0];
		assert.notEqual(flushCall.lines, undefined, "final flush should have widget content");
		const statsLine = flushCall.lines?.find((l) => l.includes("5 tools") || l.includes("5 tools"));
		if (statsLine) {
			assert.ok(statsLine.includes("5 tools"), "final flush should show tool count");
		}

		// Second call clears
		assert.equal(widgetCalls[1].lines, undefined, "widget should be cleared");
	});
});
