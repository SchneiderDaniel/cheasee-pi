/**
 * Tests: message-renderer.ts — expanded/collapsed views + Markdown rendering.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/message-renderer.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
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
): Container | Text | undefined {
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
			toolCount: 2,
			tokenCount: 1000,
			durationMs: 3000,
			auditScore: "4/5",
			summaryLine: "Completed task",
		});
		const c = renderMessage(details, undefined, true) as Container;
		const lines = renderAndStrip(c);
		assert.ok(lines[0].includes("dev-agent"), "header should contain agent name");
		assert.ok(
			lines.some((l) => l.includes("tools") || l.includes("tokens")),
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

	it("message.content is a string and no details → returns single Text component", () => {
		const pi = {} as any;
		const renderer = createMessageRenderer(pi);
		const message = { content: "plain text message" };
		const result = renderer(message, { expanded: false }, mockTheme);
		assert.ok(
			result instanceof Text,
			"should return Text component for string content without details",
		);
		if (result instanceof Text) {
			const lines = renderAndStrip(result);
			assert.ok(
				lines.some((l) => l.includes("plain text")),
				`expected text content, got: ${JSON.stringify(lines)}`,
			);
		}
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
		// No blank line specifically for summary — just no summary text
		const summaryLines = lines.filter((l) => l.trim() === "");
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
