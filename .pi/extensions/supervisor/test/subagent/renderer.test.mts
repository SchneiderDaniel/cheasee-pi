/**
 * Tests: subagent/renderer.ts — expanded view output/thinking split.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/subagent/renderer.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Container, Text, Spacer, Markdown, type Component } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderSubagentResult } from "../../subagent/renderer.ts";
import type { SubagentDetails, AgentToolResult } from "../../subagent/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────

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

function makeDetails(overrides: Partial<SubagentDetails> = {}): SubagentDetails {
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

interface MakeResultOptions {
	details?: Partial<SubagentDetails>;
	outputText?: string;
	thinkingOutput?: string | undefined; // undefined = not set (fallback case)
}

function makeResult(opts: MakeResultOptions = {}): AgentToolResult<SubagentDetails> {
	const thinkingOutput = opts.thinkingOutput;
	const details = makeDetails({
		...(thinkingOutput !== undefined ? { thinkingOutput } : {}),
		...opts.details,
	});
	return {
		content: opts.outputText ? [{ type: "text" as const, text: opts.outputText }] : [],
		details,
	};
}

// ─── Tests ───────────────────────────────────────────────────────

describe("renderSubagentResult — collapsed view", () => {
	before(() => {
		initTheme();
	});

	it("collapsed view shows header, stats, summary line", () => {
		const result = makeResult({ outputText: "some output" });
		const c = renderSubagentResult(result, { expanded: false, isPartial: false }, mockTheme, {});

		// collapsed view returns a Text component (joined lines)
		assert.ok(c instanceof Text, "collapsed view should return Text");
		const text = (c as Text)
			.render(80)
			.map((l) => stripAnsi(l).trim())
			.join("\n");
		assert.ok(text.includes("test-agent"), "should have agent name");
		assert.ok(text.includes("↑500 ↓1.0K"), `should have token stats, got: ${text}`);
		assert.ok(text.includes("Completed task"), "should have summary");
	});

	it("collapsed view unchanged from before split — same format", () => {
		const result = makeResult({ outputText: "output", thinkingOutput: "thinking" });
		const c = renderSubagentResult(result, { expanded: false, isPartial: false }, mockTheme, {});
		assert.ok(c instanceof Text, "collapsed view should return Text");
	});

	it("partial/in-progress state returns muted Text with first content item", () => {
		const result = makeResult({ outputText: "Still running..." });
		const c = renderSubagentResult(result, { expanded: false, isPartial: true }, mockTheme, {});
		assert.ok(c instanceof Text, "partial should return Text");
		const text = (c as Text)
			.render(80)
			.map((l) => stripAnsi(l).trim())
			.join("\n");
		assert.ok(text.includes("Still running..."), "should show partial content");
	});

	it("partial with no content shows 'Running...' fallback", () => {
		const result = makeResult();
		const c = renderSubagentResult(result, { expanded: false, isPartial: true }, mockTheme, {});
		assert.ok(c instanceof Text, "partial should return Text");
		const text = (c as Text)
			.render(80)
			.map((l) => stripAnsi(l).trim())
			.join("\n");
		assert.ok(text.includes("Running..."), "should show Running... fallback");
	});
});

describe("renderSubagentResult — expanded view with separated output/thinking", () => {
	before(() => {
		initTheme();
	});

	it("happy path: both output and thinkingOutput → separate sections", () => {
		const result = makeResult({
			outputText: "Here is the result",
			thinkingOutput: "I thought about this carefully",
		});
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		assert.ok(c instanceof Container, "expanded view should return Container");
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("── Output ──")),
			"should have Output header",
		);
		assert.ok(
			lines.some((l) => l.includes("── Thinking ──")),
			"should have Thinking header",
		);
		assert.ok(
			lines.some((l) => l.includes("Here is the result")),
			"should have output content",
		);
		assert.ok(
			lines.some((l) => l.includes("I thought about this carefully")),
			"should have thinking content",
		);
	});

	it("output renders as regular Markdown (no italic on defaultTextStyle)", () => {
		const result = makeResult({
			outputText: "regular output",
			thinkingOutput: "thinking text",
		});
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const children = (c as any).children || [];
		// Find Markdown children
		const mdChildren = children.filter((child: any) => child instanceof Markdown);
		// There should be at least one Markdown child (for output)
		assert.ok(mdChildren.length >= 1, "should have at least one Markdown child");
		// The output Markdown should NOT have italic: true
		const outputMd = mdChildren[0];
		assert.notEqual(
			(outputMd as any).defaultTextStyle?.italic,
			true,
			"output Markdown should NOT have italic: true",
		);
	});

	it("thinking section uses Markdown with thinkingText + italic (via renderThinkingBlock)", () => {
		const result = makeResult({
			outputText: "output",
			thinkingOutput: "thinking content",
		});
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const children = (c as any).children || [];
		// Find the Markdown child that has italic: true (thinking block)
		const thinkingMd = children.find(
			(child: any) => child instanceof Markdown && (child as any).defaultTextStyle?.italic === true,
		);
		assert.ok(thinkingMd, "should have a Markdown child with italic: true for thinking");
		assert.ok(
			(thinkingMd as any).defaultTextStyle?.color,
			"thinking Markdown should have a color function",
		);
	});

	it("only output text, no thinkingOutput → only Output section renders", () => {
		const result = makeResult({
			outputText: "just output",
			thinkingOutput: "",
		});
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("── Output ──")),
			"should have Output header",
		);
		assert.ok(!lines.some((l) => l.includes("── Thinking ──")), "should NOT have Thinking header");
	});

	it("only thinkingOutput, no output text → only Thinking section renders", () => {
		const result = makeResult({
			outputText: "",
			thinkingOutput: "just thinking",
		});
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const lines = renderStripped(c);
		assert.ok(
			!lines.some((l) => l.includes("── Output ──")),
			"should NOT have Output header when output is empty",
		);
		assert.ok(
			lines.some((l) => l.includes("── Thinking ──")),
			"should have Thinking header",
		);
		assert.ok(
			lines.some((l) => l.includes("just thinking")),
			"should have thinking content",
		);
	});

	it("output text > MAX_EXPANDED_OUTPUT_CHARS → truncated with notice", () => {
		const longText = "A".repeat(8500);
		const result = makeResult({
			outputText: longText,
			thinkingOutput: "thinking",
		});
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("truncated")),
			"should have truncated notice",
		);
	});

	it("empty thinkingOutput → section skipped (no header)", () => {
		const result = makeResult({
			outputText: "output",
			thinkingOutput: "",
		});
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const lines = renderStripped(c);
		assert.ok(
			!lines.some((l) => l.includes("── Thinking ──")),
			"should NOT have Thinking header when thinking is empty",
		);
	});

	it("empty output text → Output section not rendered", () => {
		const result = makeResult({
			outputText: "",
			thinkingOutput: "thinking",
		});
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const lines = renderStripped(c);
		assert.ok(
			!lines.some((l) => l.includes("── Output ──")),
			"should NOT have Output header when output is empty",
		);
	});

	it("footer stats line renders same format as before", () => {
		const details = makeDetails({
			turnCount: 3,
			inputTokens: 500,
			outputTokens: 1000,
			cacheRead: 200,
			cacheWrite: 100,
			cost: 0.0123,
			model: "claude-sonnet-4",
			durationMs: 15000,
		});
		const result: AgentToolResult<SubagentDetails> = {
			content: [{ type: "text", text: "output" }],
			details,
		};
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const lines = renderStripped(c);
		const footerLine = lines.find((l) => l.includes("turns") && l.includes("↑"));
		assert.ok(footerLine, "should have footer stats line");
		assert.ok(footerLine!.includes("3 turns"), "should show turn count");
		assert.ok(footerLine!.includes("↑500 ↓1.0K"), "should show tokens");
		assert.ok(footerLine!.includes("claude-sonnet-4"), "should show model");
		assert.ok(footerLine!.includes("15s"), "should show duration");
	});

	it("task section and tools section unchanged", () => {
		const details = makeDetails({
			taskPrompt: "Build the feature",
			toolCalls: [
				{ name: "bash", args: { command: "ls" } },
				{ name: "read", args: { path: "file.ts" } },
			],
		});
		const result: AgentToolResult<SubagentDetails> = {
			content: [{ type: "text", text: "done" }],
			details,
		};
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("── Task ──")),
			"should have Task section",
		);
		assert.ok(
			lines.some((l) => l.includes("Build the feature")),
			"should have task content",
		);
		assert.ok(
			lines.some((l) => l.includes("── Tools ──")),
			"should have Tools section",
		);
		assert.ok(
			lines.some((l) => l.includes("$") && l.includes("ls")),
			"should have tool call",
		);
	});
});

describe("renderSubagentResult — fallback (thinkingOutput undefined)", () => {
	before(() => {
		initTheme();
	});

	it("thinkingOutput undefined → combined '── 💭 Thinking & Output ──' header", () => {
		// Create result WITHOUT thinkingOutput (undefined = not in data source)
		const result: AgentToolResult<SubagentDetails> = {
			content: [{ type: "text", text: "combined output and thinking" }],
			details: makeDetails(),
			// details.thinkingOutput is NOT set → undefined
		};
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("💭 Thinking & Output")),
			"should have combined header",
		);
	});

	it("thinkingOutput undefined with empty output → no combined section", () => {
		const result: AgentToolResult<SubagentDetails> = {
			content: [],
			details: makeDetails(),
		};
		const c = renderSubagentResult(result, { expanded: true, isPartial: false }, mockTheme, {});
		const lines = renderStripped(c);
		assert.ok(
			!lines.some((l) => l.includes("💭")),
			"should NOT show combined header when output is empty",
		);
	});
});
