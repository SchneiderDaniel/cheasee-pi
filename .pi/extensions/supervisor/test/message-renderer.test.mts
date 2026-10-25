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

	it("does NOT show '── Output Preview ──' header in collapsed view", () => {
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

	it("renders '── Output Preview ──' header and output content", () => {
		const details = makeSubagentDetails({ thinkingOutput: "" });
		const result = makeSubagentResult(details, { outputText: "Here is the result" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("── Output Preview ──")),
			`expected Output header, got: ${JSON.stringify(lines)}`,
		);
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

	it("collapsed view includes thinking level icon and name", () => {
		const details = makeSubagentDetails({ thinkingLevel: "medium" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, false) as Text;
		const text = renderAndStrip(c).join(" ");
		assert.ok(text.includes("◒"), "should show medium thinking icon");
		assert.ok(text.includes("medium"), "should show thinking level name");
	});

	it("collapsed view omits thinking level when not set", () => {
		const details = makeSubagentDetails({ thinkingLevel: undefined });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, false) as Text;
		const text = renderAndStrip(c).join(" ");
		assert.ok(!text.includes("◒"), "should not show thinking icon when undefined");
	});

	it("expanded view footer includes thinking level icon and name", () => {
		const details = makeSubagentDetails({ thinkingLevel: "high" });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		const footerLine = lines.find((l) => l.includes("◓"));
		assert.ok(footerLine, "expanded footer should show high thinking icon");
		assert.ok(footerLine!.includes("high"), "expanded footer should show thinking name");
	});

	it("expanded view footer omits thinking level when not set", () => {
		const details = makeSubagentDetails({ thinkingLevel: undefined });
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		const hasThinkingLevelIcon = lines.some(
			(l) =>
				l.includes("◒") ||
				l.includes("◓") ||
				l.includes("○") ||
				l.includes("◐") ||
				l.includes("◑") ||
				l.includes("●"),
		);
		assert.equal(hasThinkingLevelIcon, false, "should not show thinking icons when not set");
	});

	it("all thinking levels render expected icon in collapsed view", () => {
		const iconMap: Record<string, string> = {
			off: "○",
			minimal: "◐",
			low: "◑",
			medium: "◒",
			high: "◓",
			xhigh: "●",
		};
		for (const [level, icon] of Object.entries(iconMap)) {
			const details = makeSubagentDetails({ thinkingLevel: level });
			const result = makeSubagentResult(details, { outputText: "output" });
			const c = renderMessage(result, undefined, false) as Text;
			const text = renderAndStrip(c).join(" ");
			assert.ok(text.includes(icon), `level '${level}' should show icon '${icon}'`);
			assert.ok(text.includes(level), `level '${level}' should show name`);
		}
	});

	it("thinking level appears in expanded view footer alongside other stats", () => {
		const details = makeSubagentDetails({
			thinkingLevel: "low",
			turnCount: 5,
			inputTokens: 100,
			outputTokens: 200,
			model: "test-model",
			durationMs: 30000,
		});
		const result = makeSubagentResult(details, { outputText: "output" });
		const c = renderMessage(result, undefined, true) as Container;
		const lines = renderStripped(c);
		const footerLine = lines.find((l) => l.includes("◑"));
		assert.ok(footerLine, "footer should contain low thinking icon");
		assert.ok(footerLine!.includes("5 turns"), "footer should still show turns");
		assert.ok(footerLine!.includes("test-model"), "footer should still show model");
	});
});
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
