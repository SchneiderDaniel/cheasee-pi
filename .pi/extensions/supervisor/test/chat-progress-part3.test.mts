import { describe, it, beforeEach } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AgentRunState } from "../config/types.ts";

import { renderWidgetFromDetails } from "../session/widget.ts";

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
	it("pipeline dispatches agent → onUpdate calls renderWidgetFromDetails → widget shows progress", () => {
		// Simulate what executeAgent does: onUpdate callback calls renderWidgetFromDetails
		const ctx = createMockCtx();

		// Phase 1: idle — initial state
		renderWidgetFromDetails(
			{ agentName: "developer", phase: "idle", startedAt: Date.now() - 1000 },
			"developer",
			"claude-sonnet-4",
			ctx,
			"agent-developer",
		);
		assert.ok(
			widgetCalls[0].lines?.some((l) => l.includes("developer")),
			"initial widget should show agent name",
		);

		// Phase 2: thinking
		renderWidgetFromDetails(
			{
				agentName: "developer",
				phase: "thinking",
				liveThinking: "Analyzing requirements...",
				startedAt: Date.now() - 1000,
			},
			"developer",
			"claude-sonnet-4",
			ctx,
			"agent-developer",
		);

		// Phase 3: tool
		renderWidgetFromDetails(
			{
				agentName: "developer",
				phase: "tool",
				currentTool: "read",
				currentToolArgs: '{"path": "file.ts"}',
				startedAt: Date.now() - 1000,
			},
			"developer",
			"claude-sonnet-4",
			ctx,
			"agent-developer",
		);

		// Phase 4: text
		renderWidgetFromDetails(
			{
				agentName: "developer",
				phase: "text",
				liveText: "Here is the implementation...",
				startedAt: Date.now() - 1000,
			},
			"developer",
			"claude-sonnet-4",
			ctx,
			"agent-developer",
		);

		// Final state: completed with stats
		renderWidgetFromDetails(
			{
				agentName: "developer",
				phase: "text",
				runningToolCount: 5,
				runningTokenCount: 2500,
				startedAt: Date.now() - 60000,
			},
			"developer",
			"claude-sonnet-4",
			ctx,
			"agent-developer",
		);

		// Verify all 5 phases produced widget calls
		assert.equal(widgetCalls.length, 5, "should have 5 widget updates for 5 phases");

		// All widget calls use same canonical format (buildWidgetLines)
		for (const call of widgetCalls) {
			assert.equal(call.id, "agent-developer", "all widget calls should use agent-developer ID");
			if (call.lines) {
				assert.ok(call.lines.length === 1, "each widget should have exactly 1 line");
			}
		}
	});
});
