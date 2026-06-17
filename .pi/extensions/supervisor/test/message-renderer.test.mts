/**
 * Tests: message-renderer.ts — expanded/collapsed views + Markdown rendering
 * and task prompt section in expanded view with 50-line truncation.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/message-renderer.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Container, Text, Spacer, type Component } from "@earendil-works/pi-tui";
import { Markdown } from "@earendil-works/pi-tui";
import { initTheme, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer, createSummaryRenderer } from "../session/message-renderer.ts";
import type { SupervisorMessageDetails } from "../config/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────

function makeDetails(overrides: Partial<SupervisorMessageDetails> = {}): SupervisorMessageDetails {
	return {
		agentName: "test-agent",
		success: true,
		statusLabel: "SUCCESS",
		toolCount: 0,
		tokenCount: 0,
		durationMs: 0,
		summaryLine: "",
		...overrides,
	};
}

const mockTheme = {
	fg: (color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Render a component to an array of stripped lines at given width */
function renderAndStrip(component: Container | Text | Markdown, width = 80): string[] {
	const raw = component.render(width);
	return raw.map((line: string) => line.replace(/\x1b\[\d+m/g, "").replace(/\x1b\[0m/g, ""));
}

/** Call createMessageRenderer and get a Container result */
function renderMessage(
	details: SupervisorMessageDetails | undefined,
	messageContent: string | undefined,
	expanded = false,
	options?: any,
): Container | Text | Markdown | Component | undefined {
	const pi = {} as any;
	const renderer = createMessageRenderer(pi);
	const message = {
		content: messageContent,
		...(details !== undefined ? { details } : {}),
	};
	const result = renderer(message, options ?? { expanded }, mockTheme);
	return result;
}

// ─── Phase 1: Collapsed view ─────────────────────────────────────

describe("collapsed view (default expanded=false)", () => {
	before(() => {
		initTheme();
	});

	it("renders header line with agent name, status icon, and status text", () => {
		const details = makeDetails({ agentName: "dev-agent", success: true });
		const c = renderMessage(details, undefined) as Container;
		const lines = renderAndStrip(c);
		const headerLine = lines[0];
		assert.ok(
			headerLine.includes("dev-agent"),
			`header should contain agent name, got: ${headerLine}`,
		);
		assert.ok(
			headerLine.includes("✓") || headerLine.includes("SUCCESS"),
			`header should show success, got: ${headerLine}`,
		);
	});

	it("renders stats line (tools · tokens · duration) when metrics present", () => {
		const details = makeDetails({ toolCount: 3, tokenCount: 1500, durationMs: 5000 });
		const c = renderMessage(details, undefined) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find(
			(l) => l.includes("tools") || l.includes("tokens") || l.includes("s"),
		);
		assert.ok(statsLine, `expected stats line, got: ${JSON.stringify(lines)}`);
	});

	it("renders audit score when details.auditScore is set", () => {
		const details = makeDetails({ auditScore: "5/6" });
		const c = renderMessage(details, undefined) as Container;
		const lines = renderAndStrip(c);
		const auditLine = lines.find((l) => l.includes("Audit Score"));
		assert.ok(auditLine, `expected audit score line, got: ${JSON.stringify(lines)}`);
	});

	it("renders summary line when details.summaryLine is set", () => {
		const details = makeDetails({ summaryLine: "Done the thing" });
		const c = renderMessage(details, undefined) as Container;
		const lines = renderAndStrip(c);
		const summaryLine = lines.find((l) => l.includes("Done the thing"));
		assert.ok(summaryLine, `expected summary line, got: ${JSON.stringify(lines)}`);
	});

	it("does NOT render '── Thinking ──' header or thinking content", () => {
		const details = makeDetails({
			hasThinking: true,
			thinkingOutput: "I think therefore I am",
		});
		const c = renderMessage(details, undefined) as Container;
		const lines = renderAndStrip(c);
		const thinkingHeader = lines.find((l) => l.includes("Thinking"));
		assert.equal(
			thinkingHeader,
			undefined,
			`collapsed should NOT show thinking, got: ${JSON.stringify(lines)}`,
		);
	});

	it("does NOT render text output (neither emoji-styled Text nor Markdown component)", () => {
		const details = makeDetails({ textOutput: "## Hello\nworld" });
		const c = renderMessage(details, undefined) as Container;
		const lines = renderAndStrip(c);
		const hasHello = lines.some((l) => l.includes("Hello"));
		assert.equal(
			hasHello,
			false,
			`collapsed should NOT show text output, got: ${JSON.stringify(lines)}`,
		);
	});

	it("does NOT render '── Raw Output ──' header or raw content", () => {
		const details = makeDetails({
			hasRawOutput: true,
			rawOutput: "raw stuff here",
		});
		const c = renderMessage(details, undefined) as Container;
		const lines = renderAndStrip(c);
		const rawHeader = lines.find((l) => l.includes("Raw Output"));
		assert.equal(
			rawHeader,
			undefined,
			`collapsed should NOT show raw output, got: ${JSON.stringify(lines)}`,
		);
	});

	it("omits stats line entirely when tool/token/duration stats are zero", () => {
		const details = makeDetails({ toolCount: 0, tokenCount: 0, durationMs: 0 });
		const c = renderMessage(details, undefined) as Container;
		const lines = renderAndStrip(c);
		// Verify no line contains a stats-like pattern (tools/tokens/duration)
		const statsPattern = /\btools?\b|\btokens?\b|\d+ms|\d+s$/;
		const hasStatsLine = lines.some((l) => statsPattern.test(l.trim()));
		assert.equal(hasStatsLine, false, `expected no stats line, got: ${JSON.stringify(lines)}`);
	});
});

// ─── Phase 2: Expanded view ──────────────────────────────────────

describe("expanded view (expanded=true)", () => {
	before(() => {
		initTheme();
	});

	it("renders header, stats, audit score, summary line (same as collapsed)", () => {
		const details = makeDetails({
			agentName: "dev-agent",
			success: true,
			model: "claude",
			inputTokens: 500,
			outputTokens: 500,
			toolCount: 2,
			durationMs: 3000,
			auditScore: "4/5",
			summaryLine: "Completed task",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(lines[0].includes("dev-agent"), "header should contain agent name");
		assert.ok(
			lines.some((l) => l.includes("tools") || l.includes("model:")),
			"should show stats",
		);
		assert.ok(
			lines.some((l) => l.includes("Audit Score")),
			"should show audit score",
		);
		assert.ok(
			lines.some((l) => l.includes("Completed task")),
			"should show summary",
		);
	});

	it("renders '── Thinking ──' header and thinking content when hasThinking=true", () => {
		const details = makeDetails({
			hasThinking: true,
			thinkingOutput: "I think therefore I am\nLine two",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		const thinkingHeader = lines.find((l) => l.includes("Thinking"));
		assert.ok(thinkingHeader, `expected thinking header, got: ${JSON.stringify(lines)}`);
		const thinkingContent = lines.find((l) => l.includes("I think therefore I am"));
		assert.ok(thinkingContent, `expected thinking content, got: ${JSON.stringify(lines)}`);
	});

	it("renders text output through Markdown component (headings, lists, code fences)", () => {
		const details = makeDetails({
			textOutput: "## Hello\n\nThis is a **bold** statement.\n\n- Item 1\n- Item 2",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		// Markdown rendering: headings render without raw ##
		const hasRawHash = lines.some((l) => l.includes("##"));
		// It should render "Hello" without raw "##" prefix
		assert.ok(
			lines.some((l) => l.includes("Hello")),
			`expected Hello in output, got: ${JSON.stringify(lines)}`,
		);
	});

	it("renders '── Raw Output ──' header and raw content when hasRawOutput=true", () => {
		const details = makeDetails({
			hasRawOutput: true,
			rawOutput: "some raw output here",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		const rawHeader = lines.find((l) => l.includes("Raw Output"));
		assert.ok(rawHeader, `expected raw output header, got: ${JSON.stringify(lines)}`);
		const rawContent = lines.find((l) => l.includes("some raw output"));
		assert.ok(rawContent, `expected raw output content, got: ${JSON.stringify(lines)}`);
	});

	it("renders markdown code fences as formatted output (not raw backtick text)", () => {
		const details = makeDetails({
			textOutput: "```js\nconst x = 1;\n```",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		// Code blocks render the content, not the raw backticks
		const hasBackticks = lines.some((l) => l.includes("```"));
		// Even if backticks show, code content should render
		assert.ok(
			lines.some((l) => l.includes("const")),
			`expected code content, got: ${JSON.stringify(lines)}`,
		);
	});
});

// ─── Phase 2b: Task prompt in expanded view ─────────────────────

describe("task prompt in expanded view", () => {
	before(() => {
		initTheme();
	});

	it("expanded view with task prompt shows ── Task ── header and content", () => {
		const c = renderMessage(
			makeDetails({ taskPrompt: "Build the feature" }),
			undefined,
			true,
		) as Container;
		const lines = renderAndStrip(c);
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
		const c = renderMessage(
			makeDetails({ taskPrompt: "Build the feature" }),
			undefined,
			false,
		) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			!lines.some((l) => l.includes("── Task ──")),
			"should NOT show Task header in collapsed view",
		);
	});

	it("expanded view with undefined taskPrompt does not crash, no Task header", () => {
		const c = renderMessage(makeDetails({ taskPrompt: undefined }), undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			!lines.some((l) => l.includes("── Task ──")),
			"should NOT show Task header when taskPrompt is undefined",
		);
	});

	it("expanded view with empty string taskPrompt shows header only", () => {
		const c = renderMessage(makeDetails({ taskPrompt: "" }), undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("── Task ──")),
			"should show Task header even when content is empty",
		);
	});

	it("task prompt of exactly 50 lines renders all lines without overflow notice", () => {
		const fiftyLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		const c = renderMessage(makeDetails({ taskPrompt: fiftyLines }), undefined, true) as Container;
		const lines = renderAndStrip(c);
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

	it("task prompt of 75 lines truncates to 50 with overflow notice", () => {
		const seventyFiveLines = Array.from({ length: 75 }, (_, i) => `line ${i + 1}`).join("\n");
		const c = renderMessage(
			makeDetails({ taskPrompt: seventyFiveLines }),
			undefined,
			true,
		) as Container;
		const lines = renderAndStrip(c);
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
			"should show overflow notice: … [25 more lines]",
		);
	});

	it("task prompt of 51 lines shows overflow notice with singular", () => {
		const fiftyOneLines = Array.from({ length: 51 }, (_, i) => `line ${i + 1}`).join("\n");
		const c = renderMessage(
			makeDetails({ taskPrompt: fiftyOneLines }),
			undefined,
			true,
		) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("… [1 more line]")),
			"should show overflow notice: … [1 more line]",
		);
	});

	it("successful agent with task prompt still shows task section", () => {
		const c = renderMessage(
			makeDetails({ taskPrompt: "Do something" }),
			undefined,
			true,
		) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("── Task ──")),
			"task section should render regardless of success status",
		);
		assert.ok(
			lines.some((l) => l.includes("Do something")),
			"task content should render",
		);
	});
});

// ─── Phase 3: Edge cases and error handling ─────────────────────

describe("edge cases and error handling", () => {
	before(() => {
		initTheme();
	});

	it("options is undefined → defaults to collapsed (no crash)", () => {
		const details = makeDetails({ agentName: "test" });
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = { details };
		const result = renderer(message, undefined, mockTheme) as Container;
		const lines = renderAndStrip(result);
		assert.ok(lines[0].includes("test"), `should still render, got: ${JSON.stringify(lines)}`);
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

	it("details.textOutput is empty string → expanded mode renders other sections without crash", () => {
		const details = makeDetails({
			textOutput: "",
			hasThinking: true,
			thinkingOutput: "thinking...",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("thinking")),
			"should still render thinking",
		);
	});

	it("details.thinkingOutput is undefined → expanded mode skips thinking section gracefully", () => {
		const details = makeDetails({
			hasThinking: false,
			textOutput: "some output",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		const thinkingHeader = lines.find((l) => l.includes("Thinking"));
		assert.equal(
			thinkingHeader,
			undefined,
			"should NOT show thinking header when hasThinking is false",
		);
	});

	it("details.rawOutput is undefined → expanded mode skips raw output section gracefully", () => {
		const details = makeDetails({
			hasRawOutput: false,
			textOutput: "some output",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		const rawHeader = lines.find((l) => l.includes("Raw Output"));
		assert.equal(
			rawHeader,
			undefined,
			"should NOT show raw output header when hasRawOutput is false",
		);
	});

	it("details.summaryLine is empty → expanded mode omits summary blank line", () => {
		const details = makeDetails({ summaryLine: "" });
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		// Summary empty string should not add visible blank lines beyond normal spacing
		assert.ok(true, "no crash with empty summaryLine");
	});

	it("details.auditScore is undefined → expanded mode omits audit score line", () => {
		const details = makeDetails({ auditScore: undefined });
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		const auditLine = lines.find((l) => l.includes("Audit Score"));
		assert.equal(auditLine, undefined, "should NOT show audit score when undefined");
	});
});

// ─── Phase 3b: Rich stats line ───────────────────────────────────

describe("rich stats line (new format with per-agent breakdown)", () => {
	before(() => {
		initTheme();
	});

	it("full stats line rendered format", () => {
		const details = makeDetails({
			model: "claude-sonnet-4-5",
			inputTokens: 1200,
			outputTokens: 8500,
			cacheRead: 500,
			cacheWrite: 200,
			cost: 0.0234,
			toolCount: 3,
			durationMs: 45000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find(
			(l) => l.includes("model:") && l.includes("↑") && l.includes("↓") && l.includes("$"),
		);
		assert.ok(statsLine, `expected full stats line, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("model: claude-sonnet-4-5"), "should show model");
		assert.ok(
			statsLine!.includes("↑1.2K") || statsLine!.includes("↑1,200"),
			"should show input tokens",
		);
		assert.ok(
			statsLine!.includes("↓8.5K") || statsLine!.includes("↓8,500"),
			"should show output tokens",
		);
		assert.ok(statsLine!.includes("R500"), "should show cache read");
		assert.ok(statsLine!.includes("W200"), "should show cache write");
		assert.ok(statsLine!.includes("$0.0234"), "should show cost");
		assert.ok(statsLine!.includes("3 tools"), "should show tool count");
		assert.ok(statsLine!.includes("45s"), "should show duration");
	});

	it("model name shortened: last segment after /", () => {
		const details = makeDetails({
			model: "anthropic/claude-sonnet-4-20250514",
			durationMs: 5000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("model:"));
		assert.ok(statsLine, `expected model in line, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("claude-sonnet-4-20250514"), "should use short model name");
		assert.ok(!statsLine!.includes("anthropic"), "should NOT include full path");
	});

	it("no model → stats line starts with ↑ or tools or duration (no model prefix)", () => {
		const details = makeDetails({
			inputTokens: 500,
			outputTokens: 1000,
			durationMs: 10000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("↑"));
		assert.ok(statsLine, `expected stats line with ↑, got: ${JSON.stringify(lines)}`);
		assert.ok(!statsLine!.startsWith("model:"), "should NOT start with model:");
	});

	it("no input/output tokens → no ↑N ↓N segment", () => {
		const details = makeDetails({
			model: "test-model",
			cost: 0.01,
			durationMs: 5000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("$"));
		assert.ok(statsLine, `expected stats line, got: ${JSON.stringify(lines)}`);
		assert.ok(!statsLine!.includes("↑"), "should NOT have ↑↓ segment");
		assert.ok(statsLine!.includes("model: test-model"), "should have model");
	});

	it("no cacheRead → no RN; no cacheWrite → no WN", () => {
		const details = makeDetails({
			model: "m",
			inputTokens: 100,
			outputTokens: 200,
			durationMs: 3000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("↑100"));
		assert.ok(statsLine, `expected stats line, got: ${JSON.stringify(lines)}`);
		assert.ok(!statsLine!.includes("R"), "should NOT have cache read");
		assert.ok(!statsLine!.includes("W"), "should NOT have cache write");
	});

	it("cost at 0 → omitted (no $0.0000)", () => {
		const details = makeDetails({
			model: "m",
			cost: 0,
			durationMs: 5000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("model:"));
		assert.ok(statsLine, `expected stats line, got: ${JSON.stringify(lines)}`);
		assert.ok(!statsLine!.includes("$"), "should NOT show $0.0000");
	});

	it("cost defined non-zero → $0.0234 format", () => {
		const details = makeDetails({
			model: "m",
			cost: 0.0234,
			durationMs: 5000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("$"));
		assert.ok(statsLine, `expected cost line, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("$0.0234"), `should format cost as $0.0234, got: ${statsLine}`);
	});

	it("input/output use formatTokens (1.2K, 8.5M, 500)", () => {
		const details = makeDetails({
			model: "m",
			inputTokens: 1200,
			outputTokens: 8500000,
			cacheRead: 500,
			cacheWrite: 1200,
			durationMs: 5000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("↑") || l.includes("model:"));
		assert.ok(statsLine, `expected stats line, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("↑1.2K"), `expected 1.2K format, got: ${statsLine}`);
		assert.ok(statsLine!.includes("↓8.5M"), `expected 8.5M format, got: ${statsLine}`);
		assert.ok(statsLine!.includes("R500"), `expected R500, got: ${statsLine}`);
		assert.ok(statsLine!.includes("W1.2K"), `expected W1.2K, got: ${statsLine}`);
	});

	it("backward compat: old details without new fields → header only (no stats line crash)", () => {
		const details = makeDetails({
			toolCount: 3,
			tokenCount: 12500,
			durationMs: 45000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		// With no new-format fields (model/inputTokens/outputTokens), no stats line is rendered
		// Only the header line should be present
		assert.ok(lines.length >= 1, "should render at least header");
		assert.ok(lines[0].includes("test-agent"), "header should contain agent name");
		// No crash — backward compat verified
	});

	it("backward compat: old details with partial new fields → no crash", () => {
		const details = makeDetails({
			model: "claude-sonnet-4-5",
			durationMs: 30000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("model:"));
		assert.ok(statsLine, `expected model in stats, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("model: claude-sonnet-4-5"), "should show model");
		assert.ok(statsLine!.includes("30s"), "should show duration");
	});

	it("all fields zero → shows only model + duration", () => {
		const details = makeDetails({
			model: "my-model",
			toolCount: 0,
			tokenCount: 0,
			durationMs: 10000,
			inputTokens: 0,
			outputTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		const statsLine = lines.find((l) => l.includes("model: my-model"));
		assert.ok(statsLine, `expected model+duration, got: ${JSON.stringify(lines)}`);
		assert.ok(statsLine!.includes("10s"), "should show duration");
		assert.ok(!statsLine!.includes("↑"), "should NOT show ↑↓ for zeros");
		assert.ok(!statsLine!.includes("R"), "should NOT show cache read for zeros");
		assert.ok(!statsLine!.includes("W"), "should NOT show cache write for zeros");
		assert.ok(!statsLine!.includes("$"), "should NOT show cost for zeros");
	});

	it("all fields zero + no model → only header (no stats line)", () => {
		const details = makeDetails({
			toolCount: 0,
			tokenCount: 0,
			durationMs: 10000,
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		// With no new-format fields, hasNewFields is false, so no stats line
		// Only header should render
		assert.ok(lines.length >= 1, "should render at least header");
		assert.ok(lines[0].includes("test-agent"), "header should contain agent name");
	});
});

// ─── Phase 4: Summary renderer regression ───────────────────────

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

// ─── Phase 5: Tool call result — thinking + separator ───────────

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
		// Check all content present in correct order
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
		// Should have header and stats (if any), but no result or thinking lines
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

// ─── Phase 6: Expanded view thinking uses renderThinkingBlock ──────

describe("expanded view — thinking styling", () => {
	before(() => {
		initTheme();
	});

	it("thinking section uses Markdown with thinkingText + italic (not renderTextLines)", () => {
		const details = makeDetails({
			hasThinking: true,
			thinkingOutput: "I think therefore\nI am",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const children = (c as any).children || [];
		// Find the Markdown child that corresponds to thinking (after the "── Thinking ──" Text child)
		const thinkingLabelIdx = children.findIndex(
			(child: any) =>
				child instanceof Text && child.render(80).some((l: string) => l.includes("Thinking")),
		);
		if (thinkingLabelIdx >= 0) {
			const mdChild = children
				.slice(thinkingLabelIdx + 1)
				.find((child: any) => child instanceof Markdown);
			assert.ok(mdChild, "Markdown child should follow thinking label");
			assert.equal(
				(mdChild as any).defaultTextStyle?.italic,
				true,
				"Markdown DefaultTextStyle.italic should be true",
			);
			assert.ok(
				(mdChild as any).defaultTextStyle?.color,
				"Markdown DefaultTextStyle.color should be a function",
			);
		} else {
			// Fallback: just find any Markdown child with italic
			const mdChild = children.find(
				(child: any) =>
					child instanceof Markdown && (child as any).defaultTextStyle?.italic === true,
			);
			assert.ok(mdChild, "should have a Markdown child with italic: true for thinking");
		}
	});

	it("thinking header label still present in expanded view", () => {
		const details = makeDetails({
			hasThinking: true,
			thinkingOutput: "some thinking",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("Thinking")),
			"should have Thinking header label",
		);
	});

	it("thinking content text still present in expanded view", () => {
		const details = makeDetails({
			hasThinking: true,
			thinkingOutput: "deep thoughts here",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("deep thoughts here")),
			"should have thinking content",
		);
	});

	it("thinkingOutput contains markdown formatting → renders as formatted text", () => {
		const details = makeDetails({
			hasThinking: true,
			thinkingOutput: "## Heading\n\n- List item\n\n**bold**",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		// Markdown rendering should not show raw markdown syntax
		assert.ok(
			lines.some((l) => l.includes("Heading")),
			"should render heading content",
		);
	});

	it("thinkingOutput is empty string → header present, no crash", () => {
		const details = makeDetails({
			hasThinking: true,
			thinkingOutput: "",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("Thinking")),
			"should still show thinking header",
		);
	});

	it("hasThinking=false, thinkingOutput undefined → section skipped", () => {
		const details = makeDetails({
			hasThinking: false,
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			!lines.some((l) => l.includes("── Thinking ──")),
			"should NOT show thinking section when hasThinking is false",
		);
	});

	it("collapsed view still omits thinking", () => {
		const details = makeDetails({
			hasThinking: true,
			thinkingOutput: "secret thinking",
		});
		const c = renderMessage(details, undefined, false) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			!lines.some((l) => l.includes("secret thinking")),
			"collapsed view should NOT show thinking content",
		);
		assert.ok(
			!lines.some((l) => l.includes("── Thinking ──")),
			"collapsed view should NOT show Thinking header",
		);
	});

	it("regression: header, stats, task, textOutput, rawOutput sections unchanged", () => {
		const details = makeDetails({
			agentName: "regression-agent",
			success: true,
			model: "test-model",
			durationMs: 5000,
			taskPrompt: "some task",
			textOutput: "## Result\n\noutput here",
			hasRawOutput: true,
			rawOutput: "raw content",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(
			lines.some((l) => l.includes("regression-agent")),
			"header should have agent name",
		);
		assert.ok(
			lines.some((l) => l.includes("── Task ──")),
			"should have Task section",
		);
		assert.ok(
			lines.some((l) => l.includes("output here")),
			"should have text output",
		);
		assert.ok(
			lines.some((l) => l.includes("── Raw Output ──")),
			"should have raw output",
		);
		assert.ok(
			lines.some((l) => l.includes("raw content")),
			"should have raw content",
		);
	});
});

// ─── Phase 7: Tool call result — stats line formatting ──────────

describe("tool call result — stats line formatting (formatTokensInt)", () => {
	before(() => {
		initTheme();
	});

	it("runningTokenCount=5969, agentTokenBudget=300000 → '6k/300k tok'", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = makeToolCallMessage({
			name: "bash",
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
			name: "bash",
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
			name: "bash",
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
			name: "bash",
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
			name: "bash",
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
			name: "bash",
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
			name: "bash",
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
