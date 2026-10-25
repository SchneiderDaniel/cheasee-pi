import { describe, it, before } from "node:test";

import assert from "node:assert/strict";

import { Box, Container, Text, Markdown, type Component } from "@earendil-works/pi-tui";

import { initTheme } from "@earendil-works/pi-coding-agent";

import {
	createMessageRenderer as createMessageRendererTyped,
	createSummaryRenderer as createSummaryRendererTyped,
} from "../session/message-renderer.ts";

type LooseRenderer = (message: any, options?: any, theme?: any) => any;

const createMessageRenderer = (...args: Parameters<typeof createMessageRendererTyped>) =>
	createMessageRendererTyped(...args) as LooseRenderer;

const createSummaryRenderer = (...args: Parameters<typeof createSummaryRendererTyped>) =>
	createSummaryRendererTyped(...args) as LooseRenderer;

import type { SubagentDetails, AgentToolResult } from "../subagent/types.ts";

import type { TextContent } from "../subagent/types.ts";

function makeSubagentDetails(overrides: Partial<SubagentDetails> = {}): SubagentDetails {
	return {
		agentName: "test-agent",
		success: true,
		statusLabel: "SUCCESS",
		summaryLine: "Completed task",
		model: "claude-sonnet-4",
		inputTokens: 500,
		outputTokens: 1000,
		cacheRead: 200,
		cacheWrite: 100,
		cost: 0.0123,
		turnCount: 3,
		durationMs: 15000,
		toolCalls: [],
		toolResults: [],
		taskPrompt: "Do the thing",
		...overrides,
	};
}

function makeSubagentResult(
	details: SubagentDetails,
	opts?: { outputText?: string },
): AgentToolResult<SubagentDetails> {
	return {
		content: opts?.outputText
			? [{ type: "text" as const, text: opts.outputText }]
			: ([] as TextContent[]),
		details,
	};
}

const mockTheme = {
	fg: (color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string, _options: any) => text,
};

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[\d+m/g, "").replace(/\x1b\[0m/g, "");
}

function renderStripped(component: Component, width = 80): string[] {
	const raw = component.render(width);
	return raw.map((line: string) => stripAnsi(line).trim());
}

function renderAndStrip(component: Component, width = 80): string[] {
	const raw = component.render(width);
	return raw.map((line: string) => line.replace(/\x1b\[\d+m/g, "").replace(/\x1b\[0m/g, ""));
}

function renderMessage(
	subagentResult: AgentToolResult<SubagentDetails> | undefined,
	messageContent?: string,
	expanded = false,
	options?: any,
): Container | Text | Markdown | Component | undefined {
	const pi = {} as any;
	const renderer = createMessageRenderer(pi);
	const message: Record<string, unknown> = {};
	if (messageContent !== undefined) message.content = messageContent;
	if (subagentResult !== undefined) {
		message.details = {
			eventType: "subagent-result",
			agentName: subagentResult.details?.agentName ?? "test-agent",
			content: subagentResult.content,
			details: subagentResult.details,
		};
	}
	const result = renderer(message, options ?? { expanded }, mockTheme);
	return result;
}

function makeToolCallMessage(tc: Record<string, unknown>) {
	return {
		details: { eventType: "tool-complete", agentName: "dev", ...tc },
	};
}

describe('eventType: "subagent-result" path (new discriminator)', () => {
	before(() => {
		initTheme();
	});

	function makeEventMessage(eventType: string, details: Record<string, unknown>) {
		return {
			details: { eventType, ...details },
		};
	}

	it("subagent-result collapsed view renders header and stats", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeEventMessage("subagent-result", {
			agentName: "dev-agent",
			content: [{ type: "text", text: "output" }],
			details: {
				agentName: "dev-agent",
				success: true,
				statusLabel: "SUCCESS",
				summaryLine: "Done",
				model: "m",
				inputTokens: 100,
				outputTokens: 200,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turnCount: 1,
				durationMs: 3000,
				toolCalls: [],
				toolResults: [],
				taskPrompt: "",
			},
		});
		const c = renderer(message, { expanded: false }, mockTheme);
		assert.ok(c instanceof Text, "collapsed subagent-result should return Text");
		const lines = renderAndStrip(c as Text);
		const headerLine = lines.find((l) => l.includes("dev-agent"));
		assert.ok(headerLine, "should include agent name");
	});

	it("subagent-result expanded view renders full stats", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeEventMessage("subagent-result", {
			agentName: "dev-agent",
			content: [{ type: "text", text: "output text" }],
			details: {
				agentName: "dev-agent",
				success: true,
				statusLabel: "SUCCESS",
				summaryLine: "Done",
				model: "m",
				inputTokens: 100,
				outputTokens: 200,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turnCount: 1,
				durationMs: 3000,
				toolCalls: [],
				toolResults: [],
				taskPrompt: "",
			},
		});
		const c = renderer(message, { expanded: true }, mockTheme);
		assert.ok(c instanceof Container, "expanded subagent-result should return Container");
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("dev-agent")),
			"should include agent name in expanded view",
		);
	});

	it("phase-change renders accent-colored text", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		// Message with both eventType and content (full format)
		const message = {
			content: "**⏳ developer — Starting**\n\nModel: `claude-sonnet-4`\nTask: test",
			details: { eventType: "phase-change", agentName: "developer", phase: "starting" },
		};
		const c = renderer(message, {}, mockTheme);
		const lines = renderAndStrip(c as any);
		assert.ok(
			lines.some((l) => l.includes("⏳")),
			"should show hourglass emoji",
		);
	});

	it("compaction renders muted text", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeEventMessage("compaction", { agentName: "dev" });
		const c = renderer(message, {}, mockTheme);
		assert.ok(c instanceof Text, "compaction should return Text");
		const lines = renderAndStrip(c as Text);
		assert.ok(
			lines.some((l) => l.includes("compacted")),
			"should show compacted message",
		);
	});

	it("error renders red text with reason", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeEventMessage("error", {
			agentName: "dev",
			toolName: "bash",
			errorReason: "command not found",
		});
		const c = renderer(message, {}, mockTheme);
		assert.ok(c instanceof Text, "error should return Text");
		const lines = renderAndStrip(c as Text);
		assert.ok(
			lines.some((l) => l.includes("command not found")),
			"should show error reason",
		);
	});

	it("budget-exceeded renders warning text", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeEventMessage("budget-exceeded", {
			agentName: "dev",
			toolCount: 5,
			tokenCount: 5000,
		});
		const c = renderer(message, {}, mockTheme);
		assert.ok(c instanceof Text, "budget-exceeded should return Text");
		const lines = renderAndStrip(c as Text);
		assert.ok(
			lines.some((l) => l.includes("budget exceeded")),
			"should show budget exceeded message",
		);
		assert.ok(
			lines.some((l) => l.includes("5 tools")),
			"should show tool count",
		);
	});

	it("tool-complete renders like old toolCallResult", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeEventMessage("tool-complete", {
			agentName: "dev",
			toolName: "bash",
			args: "ls",
			isError: false,
			resultText: "file1.txt\nfile2.txt",
			thinking: "I ran ls",
			toolIndex: "#1",
			toolDurationMs: 1234,
			runningToolCount: 1,
			maxToolCalls: 10,
			runningTokenCount: 500,
			agentTokenBudget: 100000,
			errorCount: 0,
			compacted: false,
		});
		const c = renderer(message, {}, mockTheme);
		assert.ok(
			c instanceof Container || c instanceof Box,
			"tool-complete should return Container or Box",
		);
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("bash")),
			"should include tool name",
		);
		assert.ok(
			lines.some((l) => l.includes("file1.txt")),
			"should include result text",
		);
		assert.ok(
			lines.some((l) => l.includes("I ran ls")),
			"should include thinking",
		);
	});

	it("unhandled eventType falls through to default Markdown rendering", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = {
			content: "fallback markdown",
			details: { eventType: "unknown-type-made-up", agentName: "dev" },
		};
		const c = renderer(message, {}, mockTheme);
		assert.ok(
			c instanceof Markdown,
			"unknown eventType should fall through to Markdown via content",
		);
	});
});
describe('eventType: "thinking" path (live thinking phase)', () => {
	before(() => {
		initTheme();
	});

	it("thinking event renders a Markdown thinking block", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = {
			content: "💭 dev",
			details: { eventType: "thinking", agentName: "dev", content: "Considering the approach" },
		};
		const c = renderer(message, {}, mockTheme) as Container;
		const children = (c as any).children || [];
		const mdChild = children.find((child: any) => child instanceof Markdown);
		assert.ok(mdChild, "should render a Markdown child for thinking");
		assert.equal(
			(mdChild as any).defaultTextStyle?.italic,
			true,
			"thinking Markdown should be italic",
		);
	});

	it("thinking event with empty content renders empty (no crash)", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = {
			content: "💭 dev",
			details: { eventType: "thinking", agentName: "dev", content: "" },
		};
		const c = renderer(message, {}, mockTheme);
		assert.ok(c instanceof Container, "should return a Container");
	});

	it("no-eventType + no content renders placeholder (old toolCallResult/_subagentResult gone)", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = { details: { toolCallResult: { name: "bash", args: "ls" } } };
		const c = renderer(message, {}, mockTheme);
		assert.ok(c instanceof Text, "should NOT render old toolCallResult — returns fallback Text");
		const lines = renderAndStrip(c as Text);
		assert.ok(
			lines.some((l) => l.includes("unhandled supervisor message")),
			`old toolCallResult should fall through, got: ${JSON.stringify(lines)}`,
		);
	});
});
