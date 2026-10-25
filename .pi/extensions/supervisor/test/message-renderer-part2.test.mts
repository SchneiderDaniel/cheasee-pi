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

describe("edge cases and error handling", () => {
	before(() => {
		initTheme();
	});

	it("options is undefined → defaults to collapsed (no crash)", () => {
		const details = makeSubagentDetails({ agentName: "test" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = {
			details: {
				eventType: "subagent-result",
				agentName: details.agentName ?? "test",
				content: result.content,
				details: result.details,
			},
		};
		const c = renderer(message, undefined, mockTheme) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("test")),
			`should still render, got: ${JSON.stringify(lines)}`,
		);
	});

	it("message.content is a string and no details → returns single Markdown component", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = { content: "plain text message" };
		const result = renderer(message, { expanded: false }, mockTheme);
		assert.ok(
			result instanceof Markdown,
			"should return Markdown component for string content without details",
		);
	});

	it("message has no details and no content → returns placeholder '(no details)'", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = {};
		const result = renderer(message, { expanded: false }, mockTheme);
		assert.ok(result instanceof Text, "should return Text component");
		if (result instanceof Text) {
			const lines = renderAndStrip(result);
			assert.ok(
				lines.some((l) => l.includes("no details")),
				`expected placeholder, got: ${JSON.stringify(lines)}`,
			);
		}
	});

	it("_subagentResult with empty toolCalls/toolResults arrays → renders gracefully (no tools section)", () => {
		const details = makeSubagentDetails({ toolCalls: [], toolResults: [], thinkingOutput: "" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		// Should still render normally without crashing
		assert.ok(
			lines.some((l) => l.includes("── Output Preview ──")),
			"should render Output section",
		);
		// No tools header since arrays are empty
		assert.ok(
			!lines.some((l) => l.includes("── Tools ──")),
			"should NOT render Tools section when arrays empty",
		);
	});
});
describe("rich stats line in collapsed view — _subagentResult path", () => {
	before(() => {
		initTheme();
	});

	it("model and token stats shown in collapsed view", () => {
		const details = makeSubagentDetails({
			model: "claude-sonnet-4-5",
			inputTokens: 1200,
			outputTokens: 8500,
			cacheRead: 500,
			cacheWrite: 200,
			cost: 0.0234,
			durationMs: 45000,
			summaryLine: "Did the work",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, false) as Text;
		const text = renderAndStrip(c).join(" ");
		// renderSubagentResult stats format: no "model:" prefix, different format
		assert.ok(
			text.includes("↑1.2K") || text.includes("↑1,200"),
			`should show input tokens, got: ${text}`,
		);
		assert.ok(text.includes("↓8.5K"), `should show output tokens, got: ${text}`);
		assert.ok(text.includes("45s"), `should show duration, got: ${text}`);
	});

	it("no input/output tokens → no ↑↓ segment in collapsed view", () => {
		const details = makeSubagentDetails({
			model: "test-model",
			inputTokens: 0,
			outputTokens: 0,
			durationMs: 5000,
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, false) as Text;
		const text = renderAndStrip(c).join(" ");
		assert.ok(!text.includes("↑0 ↓0"), "should NOT show zero tokens");
	});
});
describe("summary renderer (createSummaryRenderer) — no regressions", () => {
	before(() => {
		initTheme();
	});

	it("createSummaryRenderer export unchanged", () => {
		assert.equal(typeof createSummaryRenderer, "function");
	});

	it("summary renderer still returns Container for string message.content", () => {
		const pi = {} as any;
		const renderer = createSummaryRenderer(pi);
		const message = { content: "## ✅ Header\n\nSome content" };
		const result = renderer(message, {}, mockTheme);
		assert.ok(result instanceof Container, "should return Container");
		if (result instanceof Container) {
			const lines = renderAndStrip(result);
			assert.ok(
				lines.some((l) => l.includes("Header")),
				`expected Header in output, got: ${JSON.stringify(lines)}`,
			);
		}
	});

	it("summary renderer handles empty/undefined content without crash", () => {
		const pi = {} as any;
		const renderer = createSummaryRenderer(pi);
		const message = {};
		const result = renderer(message, {}, mockTheme);
		assert.ok(result instanceof Container, "should return Container for empty content");
	});

	it("summary renderer preserves emoji prefix coloring for ✅/❌/⏹ headers", () => {
		const pi = {} as any;
		const renderer = createSummaryRenderer(pi);
		const message = { content: "## ✅ Success message\n\nDetails" };
		const result = renderer(message, {}, mockTheme);
		assert.ok(result instanceof Container, "should return Container");
	});
});
describe("tool call result — thinking and separator", () => {
	before(() => {
		initTheme();
	});

	it("both resultText and thinking present → separator label between them", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			resultText: "file1.txt\nfile2.txt",
			thinking: "I ran ls to list files",
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		const outputIdx = lines.findIndex((l) => l.includes("file1.txt"));
		const thinkingLabelIdx = lines.findIndex((l) => l.includes("── Thinking ──"));
		const thinkingContentIdx = lines.findIndex((l) => l.includes("I ran ls"));
		assert.notEqual(outputIdx, -1, "should have resultText content");
		assert.notEqual(thinkingLabelIdx, -1, "should have thinking separator label");
		assert.notEqual(thinkingContentIdx, -1, "should have thinking content");
		assert.ok(outputIdx < thinkingLabelIdx, "resultText should appear before thinking separator");
		assert.ok(
			thinkingLabelIdx < thinkingContentIdx,
			"thinking separator should appear before thinking content",
		);
	});

	it("only resultText, no thinking → no separator, no thinking block", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			resultText: "file1.txt",
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("file1.txt")),
			"should have resultText",
		);
		assert.ok(
			!lines.some((l) => l.includes("── Thinking ──")),
			"should NOT have thinking separator",
		);
	});

	it("only thinking, no resultText → thinking block without separator label", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			thinking: "just thinking",
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("just thinking")),
			"should have thinking content",
		);
		assert.ok(
			!lines.some((l) => l.includes("── Thinking ──")),
			"should NOT have thinking separator when no resultText",
		);
	});

	it("neither resultText nor thinking → no extra content beyond header/stats", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("bash")),
			"should have header with tool name",
		);
		assert.ok(!lines.some((l) => l.includes("file1")), "should NOT have resultText content");
		assert.ok(!lines.some((l) => l.includes("thinking")), "should NOT have thinking content");
	});

	it("error tool call with both resultText and thinking → both render correctly", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "invalid",
			resultText: "error output",
			thinking: "I tried to run invalid command",
			isError: true,
			errorReason: "command not found",
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("error output")),
			"should have resultText",
		);
		assert.ok(
			lines.some((l) => l.includes("I tried to run")),
			"should have thinking content",
		);
		assert.ok(
			lines.some((l) => l.includes("── Thinking ──")),
			"should have thinking separator",
		);
		assert.ok(
			lines.some((l) => l.includes("command not found")),
			"should have error reason",
		);
	});

	it("thinking renders via Markdown with renderThinkingBlock (italic flag on Markdown)", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "bash",
			args: "ls",
			thinking: "**bold** and *italic* thinking",
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const children = (c as any).children || [];
		const mdChild = children.find((child: any) => child instanceof Markdown);
		assert.ok(mdChild, "should have a Markdown child for thinking");
		assert.equal(
			(mdChild as any).defaultTextStyle?.italic,
			true,
			"Markdown DefaultTextStyle.italic should be true",
		);
		assert.ok(
			(mdChild as any).defaultTextStyle?.color,
			"Markdown DefaultTextStyle.color should be a function",
		);
	});

	it("resultText with ANSI-like patterns still highlights correctly", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			toolName: "grep",
			args: "-r pattern",
			resultText: "3 matches\n1. src/file.ts:42:hello\n2. src/other.ts:10:world",
			isError: false,
		});
		const c = renderer(message, {}, mockTheme) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("3 matches")),
			"should show match count",
		);
		assert.ok(
			lines.some((l) => l.includes("file.ts:42:hello")),
			"should show file:line entry",
		);
	});
});
describe("expanded view — thinking styling via renderSubagentResult", () => {
	before(() => {
		initTheme();
	});

	it("thinkingOutput is empty string → no thinking section, output section renders, no crash", () => {
		const details = makeSubagentDetails({
			thinkingOutput: "",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		// Empty thinkingOutput skips thinking section
		assert.ok(
			!lines.some((l) => l.includes("── Thinking ──")),
			"should NOT show Thinking header when thinkingOutput is empty string",
		);
		// Output section still renders
		assert.ok(
			lines.some((l) => l.includes("── Output Preview ──")),
			"should show Output header",
		);
	});

	it("collapsed view still omits thinking", () => {
		const details = makeSubagentDetails({
			thinkingOutput: "secret thinking",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, false) as Text;
		const text = renderAndStrip(c).join(" ");
		assert.ok(!text.includes("secret thinking"), "collapsed view should NOT show thinking content");
		assert.ok(!text.includes("── Thinking ──"), "collapsed view should NOT show Thinking header");
	});

	it("regression: header, stats, task, output all present in expanded view", () => {
		const details = makeSubagentDetails({
			agentName: "regression-agent",
			success: true,
			model: "claude-sonnet-4",
			durationMs: 5000,
			taskPrompt: "some task",
			inputTokens: 100,
			outputTokens: 200,
			turnCount: 2,
			thinkingOutput: "",
		});
		const result = makeSubagentResult(details, { outputText: "## Result\n\noutput here" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("regression-agent")),
			"header should have agent name",
		);
		assert.ok(
			lines.some((l) => l.includes("── Task ──")),
			"should have Task section",
		);
		assert.ok(
			lines.some((l) => l.includes("── Output Preview ──")),
			"should have Output section",
		);
		assert.ok(
			!lines.some((l) => l.includes("── Raw Output ──")),
			"should NOT have Raw Output section",
		);
	});
});
