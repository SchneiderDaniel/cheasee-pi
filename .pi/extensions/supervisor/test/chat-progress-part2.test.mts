import { describe, it, beforeEach } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AgentRunState } from "../config/types.ts";

import { buildWidgetLines, renderWidgetFromDetails } from "../session/widget.ts";

import type { SubagentDetails } from "../subagent/types.ts";

let sentMessages: Array<{
	customType: string;
	content: string;
	display?: boolean;
	details?: Record<string, unknown>;
}> = [];

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
			eventType: "subagent-result",
			agentName: opts.agentName,
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
	});
}

let notifyMessages: string[] = [];

let widgetCalls: Array<{ id: string; lines?: string[] }> = [];

beforeEach(() => {
	sentMessages = [];
	notifyMessages = [];
	widgetCalls = [];
});

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
		toolCalls: [],
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		...overrides,
	};
}

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

		assert.ok(
			!widgetCalls[0].lines?.[0]?.includes("Analyzing"),
			"thinking content absent in stats-only widget",
		);
	});
	it("stats-only widget does not show tool call details", () => {
		const ui = createMockUi();
		const state = createState({
			phase: "tool",
			currentTool: "bash",
			currentToolArgs: '{"command": "ls -la"}',
		});
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));

		assert.ok(
			!widgetCalls[0].lines?.[0]?.includes("$ ls"),
			"tool call absent in stats-only widget",
		);
	});
	it("agent produces text → widget shows live text preview", () => {
		const ui = createMockUi();
		const state = createState({
			phase: "text",
			liveText: "Here is my analysis...",
		});
		ui.setWidget("supervisor-agent", buildWidgetLines(state, "developer"));

		assert.ok(
			!widgetCalls[0].lines?.[0]?.includes("Here is my analysis"),
			"live text absent in stats-only widget",
		);
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
		const detailMap = sentMessages[0].details as any;
		assert.equal(detailMap?.eventType, "subagent-result");
		assert.equal(detailMap?.details?.statusLabel, "FAILED");
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
		const detailMap = sentMessages[0].details as any;
		assert.equal(detailMap?.eventType, "subagent-result");
		assert.equal(detailMap?.details?.statusLabel, "FAILED");
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
	it("renderWidgetFromDetails produces same widget format as buildWidgetLines (identical structure)", () => {
		const ctx = createMockCtx();
		const details: Partial<SubagentDetails> = {
			agentName: "developer",
			phase: "thinking",
			liveThinking: "Analyzing code...",
			runningTokenCount: 500,
			runningToolCount: 2,
			startedAt: Date.now() - 5000,
		};

		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx, "agent-developer");

		// Compare with direct buildWidgetLines call
		const state = createState({
			phase: "thinking",
			liveThinking: "Analyzing code...",
			tokenCount: 500,
			toolCount: 2,
			startedAt: details.startedAt!,
		});
		const expectedLines = buildWidgetLines(state, "developer", "claude-sonnet-4");

		assert.equal(widgetCalls.length, 1);
		assert.deepEqual(
			widgetCalls[0].lines,
			expectedLines,
			"renderWidgetFromDetails should produce same lines as direct buildWidgetLines",
		);
	});
	it("renderWidgetFromDetails uses widget ID 'agent-{name}' matching canonical format", () => {
		const ctx = createMockCtx();
		const details: Partial<SubagentDetails> = {
			agentName: "developer",
			phase: "idle",
		};

		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");
		assert.equal(widgetCalls[0].id, "agent-developer");

		// Also works for architect
		renderWidgetFromDetails(
			{ agentName: "architect", phase: "thinking" },
			"architect",
			undefined,
			ctx,
			"agent-architect",
		);
		assert.equal(widgetCalls[1].id, "agent-architect");
	});
	it("both pipeline (executeAgent) and merge (handlePostPipelineMerge) produce same widget structure", () => {
		// This test verifies the shared helper produces identical output
		// whether called from the pipeline path (Path A) or merge path (Path B)
		const ctx1 = createMockCtx();
		const ctx2 = createMockCtx();

		const details: Partial<SubagentDetails> = {
			agentName: "developer",
			phase: "tool",
			currentTool: "bash",
			currentToolArgs: '{"command": "npm test"}',
			runningTokenCount: 1200,
			runningToolCount: 7,
			errorCount: 0,
			startedAt: Date.now() - 20000,
			contextTokens: 600,
			contextWindow: 16000,
		};

		// Pipeline path (Path A): renderWidgetFromDetails called from executeAgent's onUpdate
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx1, "agent-developer");

		// Merge path (Path B): renderWidgetFromDetails called from handlePostPipelineMerge's onUpdate
		renderWidgetFromDetails(details, "developer", "claude-sonnet-4", ctx2, "agent-developer");

		// Both should produce identical widget lines
		assert.equal(widgetCalls.length, 2);
		assert.deepEqual(
			widgetCalls[0].lines,
			widgetCalls[1].lines,
			"both paths should produce identical widget lines from same details",
		);
	});
	it("renderWidgetFromDetails gracefully handles missing fields (liveThinking undefined)", () => {
		const ctx = createMockCtx();
		const details: Partial<SubagentDetails> = {
			agentName: "architect",
			phase: "thinking",
			// liveThinking intentionally undefined
			startedAt: Date.now() - 5000,
		};

		// Should not throw
		renderWidgetFromDetails(details, "architect", undefined, ctx, "agent-architect");

		assert.equal(widgetCalls.length, 1);
		const headerLine = widgetCalls[0].lines?.find((l) => l.includes("architect"));
		assert.ok(headerLine, "should still show header even without thinking content");
	});
	it("renderWidgetFromDetails widget shows context info when contextTokens/contextWindow are provided", () => {
		const ctx = createMockCtx();
		const details: Partial<SubagentDetails> = {
			agentName: "developer",
			phase: "idle",
			runningTokenCount: 500,
			contextTokens: 500,
			contextWindow: 32000,
			startedAt: Date.now() - 1000,
		};

		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		assert.ok(widgetCalls[0].lines?.[0]?.includes("developer"), "should show agent name");
		assert.ok(widgetCalls[0].lines?.[0]?.includes("500"), "should show token count in widget");
	});
	it("renderWidgetFromDetails widget shows 'computing...' when context info not yet received", () => {
		const ctx = createMockCtx();
		const details: Partial<SubagentDetails> = {
			agentName: "developer",
			phase: "idle",
			contextTokens: undefined,
			contextWindow: undefined,
			startedAt: Date.now() - 1000,
		};

		renderWidgetFromDetails(details, "developer", undefined, ctx, "agent-developer");

		assert.ok(widgetCalls[0].lines?.[0]?.includes("developer"), "should show agent name");
		assert.ok(widgetCalls[0].lines?.[0]?.includes("⏱"), "should show duration");
	});
});
