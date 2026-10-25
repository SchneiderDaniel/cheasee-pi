import { describe, it, before } from "node:test";

import assert from "node:assert/strict";

import { Container, Text, Markdown, type Component } from "@earendil-works/pi-tui";

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

describe("tool call result — stats line formatting (formatTokensInt)", () => {
	before(() => {
		initTheme();
	});

	it("runningTokenCount=5969, agentTokenBudget=300000 → '6k/300k tok'", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			runningTokenCount: 5969,
			agentTokenBudget: 300000,
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("tok"));
		assert.ok(statsLine, `expected tok in stats, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("6k/300k tok"), `expected 6k/300k tok, got: ${statsLine}`);
		assert.ok(!statsLine!.includes("5969"), "should NOT contain raw token count 5969");
		assert.ok(!statsLine!.includes("300K"), "should NOT contain uppercase K");
	});

	it("runningTokenCount=500, agentTokenBudget=100000 → '500/100k tok'", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			runningTokenCount: 500,
			agentTokenBudget: 100000,
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("tok"));
		assert.ok(statsLine, `expected tok in stats, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("500/100k tok"), `expected 500/100k tok, got: ${statsLine}`);
	});

	it("runningTokenCount=1500, agentTokenBudget=1500 → '2k/2k tok'", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			runningTokenCount: 1500,
			agentTokenBudget: 1500,
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("tok"));
		assert.ok(statsLine, `expected tok in stats, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("2k/2k tok"), `expected 2k/2k tok, got: ${statsLine}`);
	});

	it("runningTokenCount=undefined → no tok segment in stats line", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			agentTokenBudget: 100000,
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const hasTok = lines.some((l) => l.includes("tok"));
		assert.equal(hasTok, false, "should NOT have tok segment when runningTokenCount is undefined");
	});

	it("runningTokenCount=500, agentTokenBudget=0 → '500 tok' (no budget when 0)", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			runningTokenCount: 500,
			agentTokenBudget: 0,
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("tok"));
		assert.ok(statsLine, `expected tok in stats, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("500 tok"), `expected "500 tok", got: ${statsLine}`);
	});

	it("runningTokenCount=1000, agentTokenBudget=undefined → '1000 tok' (no budget when missing)", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			runningTokenCount: 1000,
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("tok"));
		assert.ok(statsLine, `expected tok in stats, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("1000 tok"), `expected "1000 tok", got: ${statsLine}`);
	});

	it("regression: other tool call render sections (header, tools, duration, thinking) unchanged", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			toolIndex: "#1",
			toolDurationMs: 1234,
			runningToolCount: 2,
			maxToolCalls: 10,
			runningTokenCount: 5969,
			agentTokenBudget: 300000,
			isError: false,
			resultText: "file1.txt",
			thinking: "I ran ls",
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		// Header, tools, duration, thinking all present
		assert.ok(
			lines.some((l) => l.includes("bash")),
			"should have tool name in header",
		);
		assert.ok(
			lines.some((l) => l.includes("2/10 tools")),
			"should have tool count",
		);
		assert.ok(
			lines.some((l) => l.includes("1.2s")),
			"should have duration",
		);
		assert.ok(
			lines.some((l) => l.includes("file1.txt")),
			"should have resultText",
		);
		assert.ok(
			lines.some((l) => l.includes("I ran ls")),
			"should have thinking content",
		);
		// Token line uses formatTokensInt
		assert.ok(
			lines.some((l) => l.includes("6k/300k tok")),
			"token line should be formatted with formatTokensInt",
		);
	});
});
describe("errorCount stats segment", () => {
	before(() => {
		initTheme();
	});

	it("errorCount: 1 → stats line contains '1 err'", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			isError: false,
			errorCount: 1,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("err"));
		assert.ok(statsLine, `expected err in stats, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("1 err"), `expected "1 err", got: ${statsLine}`);
	});

	it("errorCount: 5 → stats line contains '5 err'", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			isError: false,
			errorCount: 5,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("err"));
		assert.ok(statsLine, `expected err in stats, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("5 err"), `expected "5 err", got: ${statsLine}`);
	});

	it("errorCount: 0 → no err segment in stats line", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			isError: false,
			errorCount: 0,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const hasErr = lines.some((l) => l.includes("err") && !l.includes("error"));
		assert.equal(hasErr, false, "should NOT have err segment when errorCount is 0");
	});

	it("errorCount: undefined → no err segment (?? 0 fallback)", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			isError: false,
			errorCount: undefined,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const hasErr = lines.some((l) => l.includes("err") && !l.includes("error"));
		assert.equal(hasErr, false, "should NOT have err segment when errorCount is undefined");
	});

	it("errorCount absent from details → no err segment", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			isError: false,
			// errorCount not set
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const hasErr = lines.some((l) => l.includes("err") && !l.includes("error"));
		assert.equal(hasErr, false, "should NOT have err segment when errorCount is absent");
	});
});
