/**
 * Tests: session/message-renderers/ — dispatch structure (Phase 2) and
 * coverage gaps (Phase 3) for the createMessageRenderer split.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/message-renderers.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as messageRendererModule from "../session/message-renderer.ts";
import { createMessageRenderer, createSummaryRenderer } from "../session/message-renderer.ts";
import { RENDERERS, fallbackRenderer } from "../session/message-renderers/index.ts";
import {
	MAX_TASK_PREVIEW_CHARS,
	MAX_EXPANDED_TOOL_CALLS,
} from "../session/message-renderers/constants.ts";
import type { SubagentDetails, AgentToolResult } from "../subagent/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDERERS_DIR = join(__dirname, "..", "session", "message-renderers");

const mockTheme = {
	fg: (color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[\d+m/g, "").replace(/\x1b\[0m/g, "");
}

function renderStripped(component: { render: (width: number) => string[] }, width = 80): string[] {
	return component.render(width).map((line: string) => stripAnsi(line).trim());
}

/** Render an eventType message through the public factory. */
function renderEvent(
	details: Record<string, unknown>,
	content?: string,
	options?: Record<string, unknown>,
) {
	const message: Record<string, unknown> = { details };
	if (content !== undefined) message.content = content;
	const renderer = createMessageRenderer({} as never);
	return renderer(message, options ?? {}, mockTheme);
}

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

function renderSubagentEvent(details: SubagentDetails, outputText?: string, expanded = false) {
	return renderEvent(
		{
			eventType: "subagent-result",
			agentName: details.agentName,
			content: outputText !== undefined ? [{ type: "text" as const, text: outputText }] : [],
			details,
		},
		undefined,
		{ expanded },
	);
}

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Dispatch structure
// ═══════════════════════════════════════════════════════════════════

describe("RENDERERS dispatch table", () => {
	it("has exactly the 8 eventType keys, no missing and no extra", () => {
		assert.deepEqual(
			[...Object.keys(RENDERERS)].sort(),
			[
				"budget-exceeded",
				"compaction",
				"error",
				"phase-change",
				"subagent-result",
				"thinking",
				"tool-complete",
				"tool-start",
			].sort(),
		);
	});

	it("maps every key to a function", () => {
		for (const [eventType, fn] of Object.entries(RENDERERS)) {
			assert.equal(typeof fn, "function", `${eventType} renderer should be a function`);
		}
	});

	it("lookup of an unknown eventType returns undefined (factory falls back)", () => {
		assert.equal(RENDERERS["made-up-type"], undefined);
	});

	it("fallbackRenderer is exported and handles string content as Markdown", () => {
		const c = fallbackRenderer({ content: "fallback" }, {}, mockTheme);
		assert.ok(c instanceof Markdown, "string content should render Markdown");
	});

	it("fallbackRenderer handles non-string content as placeholder Text", () => {
		const c = fallbackRenderer({}, {}, mockTheme);
		assert.ok(c instanceof Text, "non-string content should render Text");
		const lines = renderStripped(c as Text);
		assert.ok(
			lines.some((l) => l.includes("unhandled supervisor message")),
			`should show placeholder, got: ${JSON.stringify(lines)}`,
		);
	});
});

describe("public surface", () => {
	it("createMessageRenderer(pi) returns a callable", () => {
		const renderer = createMessageRenderer({} as never);
		assert.equal(typeof renderer, "function");
		const c = renderer({ details: { eventType: "compaction" } }, {}, mockTheme);
		assert.ok(c instanceof Text);
	});

	it("createMessageRenderer accepts optional cwd (drives tool-call rendering)", () => {
		const renderer = createMessageRenderer({} as never, "/workspace/repo");
		const c = renderer(
			{
				details: {
					eventType: "subagent-result",
					content: [],
					details: makeSubagentDetails({
						toolCalls: [{ name: "ripgrep_search", args: { query: "x" } }],
					}),
				},
			},
			{ expanded: true },
			mockTheme,
		);
		assert.ok(c instanceof Container);
	});

	it("createSummaryRenderer(pi) is still exported and returns a callable", () => {
		const renderer = createSummaryRenderer({} as never);
		assert.equal(typeof renderer, "function");
		const c = renderer({ content: "## done" }, {}, mockTheme);
		assert.ok(c instanceof Container);
	});

	it("renderSubagentResultInline is no longer exported from message-renderer.ts", () => {
		assert.ok(
			!("renderSubagentResultInline" in messageRendererModule),
			"internal helper must not leak from the public module",
		);
	});
});

describe("no-details guard sits before table lookup", () => {
	it("no details + string content → Markdown (no dereference of details)", () => {
		const renderer = createMessageRenderer({} as never);
		const c = renderer({ content: "**hi**" }, {}, mockTheme);
		assert.ok(c instanceof Markdown);
	});

	it("no details + no content → Text '(no details)'", () => {
		const renderer = createMessageRenderer({} as never);
		const c = renderer({}, {}, mockTheme);
		assert.ok(c instanceof Text);
		const lines = renderStripped(c as Text);
		assert.ok(
			lines.some((l) => l.includes("(no details)")),
			`should show no-details placeholder, got: ${JSON.stringify(lines)}`,
		);
	});
});

describe("message-renderers/constants.ts", () => {
	it("exports shared numeric constants with identical values", () => {
		assert.equal(MAX_TASK_PREVIEW_CHARS, 80);
		assert.equal(MAX_EXPANDED_TOOL_CALLS, 30);
	});
});

describe("message-renderers/* import standalone (no ESM cycle)", () => {
	const files = readdirSync(RENDERERS_DIR).filter((f) => f.endsWith(".ts"));

	for (const f of files) {
		it(`${f} dynamically imports without TDZ errors`, async () => {
			await import(`../session/message-renderers/${f}`);
		});
	}

	it("no renderer imports back from message-renderer.ts", () => {
		for (const f of files) {
			const source = readFileSync(join(RENDERERS_DIR, f), "utf8");
			assert.ok(
				!source.includes('from "../message-renderer.ts"'),
				`${f} must not import back from message-renderer.ts (ESM cycle risk)`,
			);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Coverage gaps
// ═══════════════════════════════════════════════════════════════════

describe("tool-start renderer", () => {
	before(() => {
		initTheme();
	});

	it("with args renders '⏳ agent — tool args'", () => {
		const c = renderEvent({
			eventType: "tool-start",
			agentName: "agent",
			toolName: "bash",
			args: "ls -la",
		});
		assert.ok(c instanceof Text);
		const lines = renderStripped(c as Text);
		assert.ok(
			lines.some((l) => l.includes("⏳ agent — bash ls -la")),
			`should include args, got: ${JSON.stringify(lines)}`,
		);
	});

	it("without args renders '⏳ agent — tool'", () => {
		const c = renderEvent({ eventType: "tool-start", agentName: "agent", toolName: "bash" });
		const lines = renderStripped(c as Text);
		assert.ok(
			lines.some((l) => l.includes("⏳ agent — bash") && !l.includes("ls -la")),
			`should omit args, got: ${JSON.stringify(lines)}`,
		);
	});
});

describe("error renderer gaps", () => {
	it("missing errorReason → '✗ Unknown error'", () => {
		const c = renderEvent({ eventType: "error", agentName: "dev", toolName: "bash" });
		const lines = renderStripped(c as Text);
		assert.ok(
			lines.some((l) => l.includes("✗ bash: Unknown error")),
			`got: ${JSON.stringify(lines)}`,
		);
	});

	it("missing toolName → '✗ reason'", () => {
		const c = renderEvent({ eventType: "error", agentName: "dev", errorReason: "boom" });
		const lines = renderStripped(c as Text);
		assert.ok(
			lines.some((l) => l.includes("✗ boom") && !l.includes(":")),
			`got: ${JSON.stringify(lines)}`,
		);
	});
});

describe("budget-exceeded renderer gaps", () => {
	it("missing toolCount/tokenCount → '0 tools, 0 tokens'", () => {
		const c = renderEvent({ eventType: "budget-exceeded", agentName: "dev" });
		const lines = renderStripped(c as Text);
		assert.ok(
			lines.some((l) => l.includes("0 tools, 0 tokens")),
			`got: ${JSON.stringify(lines)}`,
		);
	});
});

describe("phase-change renderer gap (single-line extra content)", () => {
	it("single-line content ≠ generated text → Markdown (not newline branch)", () => {
		const c = renderEvent(
			{ eventType: "phase-change", agentName: "dev", phase: "starting" },
			"⏳ dev — starting phase with extra info",
		);
		assert.ok(c instanceof Markdown, "single-line extra content should render Markdown");
	});
});

describe("subagent-result expanded overflow boundaries", () => {
	before(() => {
		initTheme();
	});

	it("exactly 30 toolCalls → no overflow line", () => {
		const toolCalls = Array.from({ length: 30 }, (_v, i) => ({
			name: "ripgrep_search",
			args: { query: `q${i}` },
		}));
		const c = renderSubagentEvent(makeSubagentDetails({ toolCalls, taskPrompt: "" }), "out", true);
		const lines = renderStripped(c as Container);
		assert.ok(
			!lines.some((l) => l.includes("more tool calls")),
			`should not overflow at 30, got: ${JSON.stringify(lines)}`,
		);
	});

	it("31 toolCalls → '… 1 more tool calls'", () => {
		const toolCalls = Array.from({ length: 31 }, (_v, i) => ({
			name: "ripgrep_search",
			args: { query: `q${i}` },
		}));
		const c = renderSubagentEvent(makeSubagentDetails({ toolCalls, taskPrompt: "" }), "out", true);
		const lines = renderStripped(c as Container);
		assert.ok(
			lines.some((l) => l.includes("… 1 more tool calls")),
			`got: ${JSON.stringify(lines)}`,
		);
	});

	it("output preview exactly 500 chars → no truncation notice", () => {
		const c = renderSubagentEvent(makeSubagentDetails(), "o".repeat(500), true);
		const lines = renderStripped(c as Container);
		assert.ok(
			!lines.some((l) => l.includes("[last 500 of")),
			`should not truncate at 500, got: ${JSON.stringify(lines)}`,
		);
	});

	it("output preview 501 chars → '…[last 500 of 501 chars]'", () => {
		const c = renderSubagentEvent(makeSubagentDetails(), "o".repeat(501), true);
		const lines = renderStripped(c as Container);
		assert.ok(
			lines.some((l) => l.includes("…[last 500 of 501 chars]")),
			`got: ${JSON.stringify(lines)}`,
		);
	});
});
