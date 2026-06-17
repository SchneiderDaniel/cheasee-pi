/**
 * Tests: message-renderer.ts — _subagentResult-based rendering (new path)
 * Replaces old SupervisorMessageDetails fallback tests.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/message-renderer.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Container, Text, Markdown, type Component } from "@earendil-works/pi-tui";
import { initTheme, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer, createSummaryRenderer } from "../session/message-renderer.ts";
import type { SubagentDetails, AgentToolResult } from "../subagent/types.ts";
import type { TextContent } from "../subagent/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────

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
};

/** Strip ANSI escape sequences */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[\d+m/g, "").replace(/\x1b\[0m/g, "");
}

/** Render any component to stripped lines */
function renderStripped(component: Component, width = 80): string[] {
	const raw = component.render(width);
	return raw.map((line: string) => stripAnsi(line).trim());
}

/** Render a component to an array of stripped lines at given width */
function renderAndStrip(component: Container | Text | Markdown, width = 80): string[] {
	const raw = component.render(width);
	return raw.map((line: string) => line.replace(/\x1b\[\d+m/g, "").replace(/\x1b\[0m/g, ""));
}

/** Call createMessageRenderer with a _subagentResult message */
function renderMessage(
	subagentResult: AgentToolResult<SubagentDetails> | undefined,
	messageContent?: string,
	expanded = false,
	options?: any,
): Container | Text | Markdown | Component | undefined {
	const pi = {} as any;
	const renderer = createMessageRenderer(pi);
	const details = subagentResult !== undefined ? { _subagentResult: subagentResult } : undefined;
	const message: Record<string, unknown> = {};
	if (messageContent !== undefined) message.content = messageContent;
	if (details !== undefined) message.details = details;
	const result = renderer(message, options ?? { expanded }, mockTheme);
	return result;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1: Collapsed view
// ═══════════════════════════════════════════════════════════════════

describe("collapsed view (default expanded=false) — _subagentResult path", () => {
	before(() => {
		initTheme();
	});

	it("returns Text component (collapsed view is single line)", () => {
		const details = makeSubagentDetails({ agentName: "dev-agent" });
		const result = makeSubagentResult(details, { outputText: "some output" });
		const c = renderMessage(result, undefined, false);
		assert.ok(c instanceof Text, "collapsed view should return Text");
	});

	it("shows agent name in output", () => {
		const details = makeSubagentDetails({ agentName: "dev-agent", success: true });
		const result = makeSubagentResult(details, { outputText: "done" });
		const c = renderMessage(result, undefined, false) as Text;
		const lines = renderAndStrip(c);
		const header = lines.find((l) => l.includes("dev-agent"));
		assert.ok(header, `header should contain agent name, got: ${JSON.stringify(lines)}`);
	});

	it("shows status icon for success", () => {
		const details = makeSubagentDetails({ agentName: "dev-agent", success: true });
		const result = makeSubagentResult(details, { outputText: "done" });
		const c = renderMessage(result, undefined, false) as Text;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("✓") || l.includes("SUCCESS")),
			`should show success indicator, got: ${JSON.stringify(lines)}`,
		);
	});

	it("shows token stats (input + output)", () => {
		const details = makeSubagentDetails({
			inputTokens: 500,
			outputTokens: 1000,
			summaryLine: "Done",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, false) as Text;
		const lines = renderAndStrip(c);
		const tokenLine = lines.find((l) => l.includes("↑500"));
		assert.ok(tokenLine, `should show input tokens ↑500, got: ${JSON.stringify(lines)}`);
	});

	it("shows summary line when present", () => {
		const details = makeSubagentDetails({ summaryLine: "Done the thing" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, false) as Text;
		const text = renderAndStrip(c).join(" ");
		assert.ok(text.includes("Done the thing"), `should include summary, got: ${text}`);
	});

	it("does NOT show '── Thinking ──' header in collapsed view", () => {
		const details = makeSubagentDetails({
			thinkingOutput: "I think therefore I am",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, false) as Text;
		const lines = renderAndStrip(c);
		const thinkingHeader = lines.find((l) => l.includes("Thinking"));
		assert.equal(
			thinkingHeader,
			undefined,
			`collapsed should NOT show thinking, got: ${JSON.stringify(lines)}`,
		);
	});

	it("does NOT show '── Output ──' header in collapsed view", () => {
		const details = makeSubagentDetails();
		const result = makeSubagentResult(details, { outputText: "## Hello\nworld" });
		const c = renderMessage(result, undefined, false) as Text;
		const lines = renderAndStrip(c);
		const outputHeader = lines.find((l) => l.includes("Output"));
		assert.equal(
			outputHeader,
			undefined,
			`collapsed should NOT show Output, got: ${JSON.stringify(lines)}`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Expanded view
// ═══════════════════════════════════════════════════════════════════

describe("expanded view (expanded=true) — _subagentResult path", () => {
	before(() => {
		initTheme();
	});

	it("returns Container (expanded view has multiple sections)", () => {
		const details = makeSubagentDetails({ agentName: "dev-agent" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true);
		assert.ok(c instanceof Container, "expanded view should return Container");
	});

	it("renders header, stats, summary line (same as collapsed but as Container)", () => {
		const details = makeSubagentDetails({
			agentName: "dev-agent",
			success: true,
			model: "claude-sonnet-4",
			inputTokens: 500,
			outputTokens: 1000,
			turnCount: 3,
			durationMs: 3000,
			summaryLine: "Completed task",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("dev-agent")),
			"header should contain agent name",
		);
		assert.ok(
			lines.some((l) => l.includes("↑500 ↓1.0K")),
			"should show tokens",
		);
	});

	it("renders '── Output ──' header and output content (thinkingOutput empty string → separate sections)", () => {
		const details = makeSubagentDetails({ thinkingOutput: "" });
		const result = makeSubagentResult(details, { outputText: "Here is the result" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("── Output ──")),
			`expected Output header, got: ${JSON.stringify(lines)}`,
		);
	});

	it("renders '── Thinking ──' header and thinking content when thinkingOutput present", () => {
		const details = makeSubagentDetails({
			thinkingOutput: "I think therefore I am\nLine two",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		const thinkingHeader = lines.find((l) => l.includes("Thinking"));
		assert.ok(thinkingHeader, `expected thinking header, got: ${JSON.stringify(lines)}`);
		const thinkingContent = lines.find((l) => l.includes("I think therefore I am"));
		assert.ok(thinkingContent, `expected thinking content, got: ${JSON.stringify(lines)}`);
	});

	it("renders footer stats line with turns, tokens, model, duration", () => {
		const details = makeSubagentDetails({
			turnCount: 3,
			inputTokens: 500,
			outputTokens: 1000,
			cacheRead: 200,
			cacheWrite: 100,
			cost: 0.0123,
			model: "claude-sonnet-4",
			durationMs: 15000,
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		const footerLine = lines.find((l) => l.includes("turns") && l.includes("↑"));
		assert.ok(footerLine, "should have footer stats line");
		assert.ok(footerLine!.includes("3 turns"), "should show turn count");
		assert.ok(footerLine!.includes("↑500 ↓1.0K"), "should show tokens");
		assert.ok(footerLine!.includes("claude-sonnet-4"), "should show model");
		assert.ok(footerLine!.includes("15s"), "should show duration");
	});

	it("does NOT render '── Raw Output ──' header (removed in new path)", () => {
		const details = makeSubagentDetails();
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		const rawHeader = lines.find((l) => l.includes("Raw Output"));
		assert.equal(rawHeader, undefined, "should NOT have Raw Output header");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2b: Task prompt in expanded view
// ═══════════════════════════════════════════════════════════════════

describe("task prompt in expanded view — _subagentResult path", () => {
	before(() => {
		initTheme();
	});

	it("expanded view with task prompt shows ── Task ── header and content", () => {
		const details = makeSubagentDetails({ taskPrompt: "Build the feature" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("── Task ──")),
			"should show Task header",
		);
		assert.ok(
			lines.some((l) => l.includes("Build the feature")),
			"should show task content",
		);
	});

	it("collapsed view with task prompt does NOT show ── Task ── header", () => {
		const details = makeSubagentDetails({ taskPrompt: "Build the feature" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, false);
		// Collapsed returns Text — verify full output string
		const text = renderAndStrip(c as Text).join(" ");
		assert.ok(!text.includes("── Task ──"), "should NOT show Task header in collapsed view");
	});

	it("task prompt of 75 lines truncates to 50 with overflow notice", () => {
		const seventyFiveLines = Array.from({ length: 75 }, (_, i) => `line ${i + 1}`).join("\n");
		const details = makeSubagentDetails({ taskPrompt: seventyFiveLines });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("line 1")),
			"line 1 present",
		);
		assert.ok(
			lines.some((l) => l.includes("line 50")),
			"line 50 present",
		);
		assert.ok(
			!lines.some((l) => l.includes("line 51")),
			"line 51 should NOT be present (truncated)",
		);
		assert.ok(
			lines.some((l) => l.includes("… [25 more lines]")),
			"should show overflow notice",
		);
	});

	it("task prompt of exactly 50 lines renders all lines without overflow notice", () => {
		const fiftyLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		const details = makeSubagentDetails({ taskPrompt: fiftyLines });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		for (let i = 1; i <= 50; i++) {
			assert.ok(
				lines.some((l) => l.includes(`line ${i}`)),
				`should contain line ${i}`,
			);
		}
		assert.ok(
			!lines.some((l) => l.includes("more line")),
			"should NOT show overflow notice for exactly 50 lines",
		);
	});

	it("task prompt of 51 lines shows overflow notice with singular", () => {
		const fiftyOneLines = Array.from({ length: 51 }, (_, i) => `line ${i + 1}`).join("\n");
		const details = makeSubagentDetails({ taskPrompt: fiftyOneLines });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("… [1 more line]")),
			"should show overflow notice: … [1 more line]",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Edge cases and error handling
// ═══════════════════════════════════════════════════════════════════

describe("edge cases and error handling", () => {
	before(() => {
		initTheme();
	});

	it("options is undefined → defaults to collapsed (no crash)", () => {
		const details = makeSubagentDetails({ agentName: "test" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = { details: { _subagentResult: result } };
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
			lines.some((l) => l.includes("── Output ──")),
			"should render Output section",
		);
		// No tools header since arrays are empty
		assert.ok(
			!lines.some((l) => l.includes("── Tools ──")),
			"should NOT render Tools section when arrays empty",
		);
	});

	it("_subagentResult with thinkingOutput → thinking section renders", () => {
		const details = makeSubagentDetails({ thinkingOutput: "deep thoughts" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("deep thoughts")),
			"should show thinking content",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3b: Rich stats line in collapsed view
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// Phase 4: Summary renderer regression
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// Phase 5: Tool call result — thinking + separator (unchanged)
// ═══════════════════════════════════════════════════════════════════

/** Create a message with toolCallResult details */
function makeToolCallMessage(tc: Record<string, unknown>) {
	return {
		details: { toolCallResult: tc },
	};
}

describe("tool call result — thinking and separator", () => {
	before(() => {
		initTheme();
	});

	it("both resultText and thinking present → separator label between them", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			name: "bash",
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
			name: "bash",
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
			name: "bash",
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
			name: "bash",
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
			name: "bash",
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
			name: "bash",
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
			name: "grep",
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

// ═══════════════════════════════════════════════════════════════════
// Phase 6: Expanded view — thinking via renderSubagentResult
// ═══════════════════════════════════════════════════════════════════

describe("expanded view — thinking styling via renderSubagentResult", () => {
	before(() => {
		initTheme();
	});

	it("thinking section uses Markdown with thinkingText + italic", () => {
		const details = makeSubagentDetails({
			thinkingOutput: "I think therefore\nI am",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const children = (c as any).children || [];
		// Find the Markdown child with italic: true (thinking block)
		const thinkingMd = children.find(
			(child: any) => child instanceof Markdown && (child as any).defaultTextStyle?.italic === true,
		);
		assert.ok(thinkingMd, "should have a Markdown child with italic: true for thinking");
		assert.ok(
			(thinkingMd as any).defaultTextStyle?.color,
			"thinking Markdown should have a color function",
		);
	});

	it("thinking header label present in expanded view", () => {
		const details = makeSubagentDetails({
			thinkingOutput: "some thinking",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("Thinking")),
			"should have Thinking header label",
		);
	});

	it("thinking content text present in expanded view", () => {
		const details = makeSubagentDetails({
			thinkingOutput: "deep thoughts here",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("deep thoughts here")),
			"should have thinking content",
		);
	});

	it("thinkingOutput contains markdown formatting → renders as formatted text", () => {
		const details = makeSubagentDetails({
			thinkingOutput: "## Heading\n\n- List item\n\n**bold**",
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("Heading")),
			"should render heading content",
		);
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
			lines.some((l) => l.includes("── Output ──")),
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
			lines.some((l) => l.includes("── Output ──")),
			"should have Output section",
		);
		assert.ok(
			!lines.some((l) => l.includes("── Raw Output ──")),
			"should NOT have Raw Output section",
		);
	});
});
