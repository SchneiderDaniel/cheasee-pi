/**
 * Golden characterization tests for session/message-renderer.ts.
 *
 * Captures byte-for-byte render output (ANSI intact) for every eventType
 * through the CURRENT createMessageRenderer, so the 231→dispatch-table
 * refactor can be proven output-equivalent.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/message-renderer-golden.test.mts
 * Regenerate goldens (only when the renderer intentionally changes):
 *   GOLDEN_UPDATE=1 node --experimental-strip-types --test .pi/extensions/supervisor/test/message-renderer-golden.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Container, Markdown, Text, setCapabilities } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer } from "../session/message-renderer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, "fixtures", "message-renderer-goldens");
const UPDATE = process.env.GOLDEN_UPDATE === "1";

// ─── Determinism pins ──────────────────────────────────────────────
// Pin terminal capabilities (truecolor) and background detection so the
// real themed render emits identical ANSI codes on every machine/CI.
process.env.COLORFGBG = "15;0"; // bg color index 0 → dark theme resolution
setCapabilities({ images: null, trueColor: true, hyperlinks: false });

const RENDER_WIDTH = 80;
const CWD = "/workspace/repo";

/**
 * The active Theme singleton set by initTheme(). Not re-exported from the
 * package index, so read it from the globalThis slot the theme module uses
 * to share state across module loaders.
 */
function activeTheme(): {
	fg: (c: string, t: string) => string;
	bg: (c: string, t: string) => string;
} {
	const t = (globalThis as Record<symbol, unknown>)[
		Symbol.for("@earendil-works/pi-coding-agent:theme")
	];
	assert.ok(t, "initTheme must run before activeTheme()");
	return t as { fg: (c: string, t: string) => string; bg: (c: string, t: string) => string };
}

/** Expected root component class name per golden case. */
const COMPONENT_BY_NAME = {
	Box,
	Container,
	Markdown,
	Text,
} as const;
type ComponentName = keyof typeof COMPONENT_BY_NAME;

interface GoldenCase {
	name: string;
	component: ComponentName;
	message: Record<string, unknown>;
	options?: Record<string, unknown>;
}

// ─── Fixture builders ──────────────────────────────────────────────

function subagentDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		agentName: "dev-agent",
		success: true,
		statusLabel: "SUCCESS",
		summaryLine: "Completed task",
		model: "anthropic/claude-sonnet-4",
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

function subagentMessage(details: Record<string, unknown>, outputText?: string) {
	return {
		details: {
			eventType: "subagent-result",
			agentName: details.agentName,
			content: outputText !== undefined ? [{ type: "text" as const, text: outputText }] : [],
			details,
		},
	};
}

function toolCalls(n: number): Array<{ name: string; args: Record<string, unknown> }> {
	return Array.from({ length: n }, (_v, i) => ({
		name: "ripgrep_search",
		args: { query: `pattern-${i}`, directory: "src" },
	}));
}

function taskPromptLines(n: number): string {
	return Array.from({ length: n }, (_v, i) => `task line ${i + 1}`).join("\n");
}

// ─── Corpus ────────────────────────────────────────────────────────

const CASES: GoldenCase[] = [
	// no-details guards
	{ name: "no-details-string", component: "Markdown", message: { content: "**hello** markdown" } },
	{ name: "no-details-empty", component: "Text", message: {} },

	// phase-change × 4
	{
		name: "phase-change-equal-text",
		component: "Text",
		message: {
			content: "⏳ dev — starting phase",
			details: { eventType: "phase-change", agentName: "dev", phase: "starting" },
		},
	},
	{
		name: "phase-change-newline-split",
		component: "Container",
		message: {
			content: "⏳ dev — starting phase\n\nModel: `claude-sonnet-4`\nTask: test",
			details: { eventType: "phase-change", agentName: "dev", phase: "starting" },
		},
	},
	{
		name: "phase-change-single-line-extra",
		component: "Markdown",
		message: {
			content: "⏳ dev — starting phase with extra info on one line",
			details: { eventType: "phase-change", agentName: "dev", phase: "starting" },
		},
	},
	{
		name: "phase-change-no-content",
		component: "Text",
		message: { details: { eventType: "phase-change", agentName: "dev", phase: "starting" } },
	},

	// tool-start × 2
	{
		name: "tool-start-with-args",
		component: "Text",
		message: {
			details: { eventType: "tool-start", agentName: "dev", toolName: "bash", args: "ls -la" },
		},
	},
	{
		name: "tool-start-no-args",
		component: "Text",
		message: { details: { eventType: "tool-start", agentName: "dev", toolName: "bash" } },
	},

	// tool-complete × 8
	{
		name: "tool-complete-success-minimal",
		component: "Box",
		message: {
			details: { eventType: "tool-complete", toolName: "bash", args: "ls", isError: false },
		},
	},
	{
		name: "tool-complete-success-full",
		component: "Box",
		message: {
			details: {
				eventType: "tool-complete",
				toolName: "bash",
				args: "ls",
				params: "--json",
				isError: false,
				toolIndex: "#1",
				toolDurationMs: 1234,
				runningToolCount: 1,
				maxToolCalls: 10,
				runningTokenCount: 500,
				agentTokenBudget: 100000,
				errorCount: 0,
				compacted: false,
				resultText: "file1.txt\nfile2.txt",
				thinking: "I ran ls",
			},
		},
	},
	{
		name: "tool-complete-error",
		component: "Box",
		message: {
			details: {
				eventType: "tool-complete",
				toolName: "bash",
				args: "rm -rf /tmp/x",
				isError: true,
				errorReason: "permission denied",
				thinking: "risky command",
				toolDurationMs: 2000,
			},
		},
	},
	{
		name: "tool-complete-no-duration",
		component: "Box",
		message: {
			details: {
				eventType: "tool-complete",
				toolName: "read",
				args: "src/main.ts",
				isError: false,
				resultText: "export const x = 1;",
			},
		},
	},
	{
		name: "tool-complete-keyword-highlight",
		component: "Box",
		message: {
			details: {
				eventType: "tool-complete",
				toolName: "bash",
				args: "run tests",
				isError: false,
				resultText: [
					"error: something failed",
					"success: all good",
					"warning: take care",
					"3 matches found",
					"Matches returned: 5",
					"1. src/main.ts:12: const x = 1",
					"[omitted long line 1234 chars]",
					"/workspace/src/app.ts:23: console.log",
				].join("\n"),
			},
		},
	},
	{
		name: "tool-complete-thinking-only",
		component: "Box",
		message: {
			details: {
				eventType: "tool-complete",
				toolName: "bash",
				args: "x",
				isError: false,
				thinking: "only a thought",
			},
		},
	},
	{
		name: "tool-complete-compacted",
		component: "Box",
		message: {
			details: {
				eventType: "tool-complete",
				toolName: "bash",
				args: "x",
				isError: false,
				compacted: true,
			},
		},
	},
	{
		name: "tool-complete-error-count",
		component: "Box",
		message: {
			details: {
				eventType: "tool-complete",
				toolName: "bash",
				args: "x",
				isError: false,
				errorCount: 3,
			},
		},
	},

	// subagent-result × 8
	{
		name: "subagent-result-collapsed-full",
		component: "Text",
		message: subagentMessage(subagentDetails()),
	},
	{
		name: "subagent-result-collapsed-no-details",
		component: "Text",
		message: {
			details: { eventType: "subagent-result", agentName: "dev-agent", content: [], details: {} },
		},
	},
	{
		name: "subagent-result-expanded-full",
		component: "Container",
		message: subagentMessage(
			subagentDetails({
				toolCalls: [
					{ name: "ripgrep_search", args: { query: "foo", directory: "src" } },
					{ name: "web_crawl", args: { url: "https://example.com" } },
				],
				taskPrompt: "Build the feature\nSecond line",
			}),
			"some output text",
		),
		options: { expanded: true },
	},
	{
		name: "subagent-result-toolcalls-30",
		component: "Container",
		message: subagentMessage(subagentDetails({ toolCalls: toolCalls(30), taskPrompt: "" }), "out"),
		options: { expanded: true },
	},
	{
		name: "subagent-result-toolcalls-31",
		component: "Container",
		message: subagentMessage(subagentDetails({ toolCalls: toolCalls(31), taskPrompt: "" }), "out"),
		options: { expanded: true },
	},
	{
		name: "subagent-result-task-50",
		component: "Container",
		message: subagentMessage(
			subagentDetails({ toolCalls: [], taskPrompt: taskPromptLines(50) }),
			"out",
		),
		options: { expanded: true },
	},
	{
		name: "subagent-result-task-51",
		component: "Container",
		message: subagentMessage(
			subagentDetails({ toolCalls: [], taskPrompt: taskPromptLines(51) }),
			"out",
		),
		options: { expanded: true },
	},
	{
		name: "subagent-result-output-500",
		component: "Container",
		message: subagentMessage(subagentDetails(), "o".repeat(500)),
		options: { expanded: true },
	},
	{
		name: "subagent-result-output-501",
		component: "Container",
		message: subagentMessage(subagentDetails(), "o".repeat(501)),
		options: { expanded: true },
	},
	{
		name: "subagent-result-expanded-no-output",
		component: "Container",
		message: subagentMessage(subagentDetails()),
		options: { expanded: true },
	},

	// thinking × 2
	{
		name: "thinking-content",
		component: "Container",
		message: {
			details: { eventType: "thinking", agentName: "dev", content: "Considering the approach" },
		},
	},
	{
		name: "thinking-empty",
		component: "Container",
		message: { details: { eventType: "thinking", agentName: "dev", content: "" } },
	},

	// error × 3
	{
		name: "error-reason-toolname",
		component: "Text",
		message: {
			details: {
				eventType: "error",
				agentName: "dev",
				toolName: "bash",
				errorReason: "command not found",
			},
		},
	},
	{
		name: "error-no-reason",
		component: "Text",
		message: { details: { eventType: "error", agentName: "dev", toolName: "bash" } },
	},
	{
		name: "error-no-toolname",
		component: "Text",
		message: { details: { eventType: "error", agentName: "dev", errorReason: "boom" } },
	},

	// budget-exceeded × 2
	{
		name: "budget-exceeded-counts",
		component: "Text",
		message: {
			details: { eventType: "budget-exceeded", agentName: "dev", toolCount: 5, tokenCount: 5000 },
		},
	},
	{
		name: "budget-exceeded-missing",
		component: "Text",
		message: { details: { eventType: "budget-exceeded", agentName: "dev" } },
	},

	// compaction × 1
	{
		name: "compaction",
		component: "Text",
		message: { details: { eventType: "compaction", agentName: "dev" } },
	},

	// unknown eventType × 2
	{
		name: "unknown-string",
		component: "Markdown",
		message: {
			content: "fallback markdown",
			details: { eventType: "made-up-type", agentName: "dev" },
		},
	},
	{
		name: "unknown-nonstring",
		component: "Text",
		message: { details: { eventType: "made-up-type", agentName: "dev" } },
	},
];

// ─── Golden helpers ────────────────────────────────────────────────

function goldenPath(name: string): string {
	return join(GOLDEN_DIR, `${name}.txt`);
}

function renderCase(c: GoldenCase): string {
	const renderer = createMessageRenderer({} as never, CWD);
	const component = renderer(c.message, c.options ?? {}, activeTheme());
	const expected = COMPONENT_BY_NAME[c.component];
	assert.ok(
		component instanceof expected,
		`${c.name}: expected ${c.component}, got ${component?.constructor?.name}`,
	);
	return component.render(RENDER_WIDTH).join("\n");
}

describe("message-renderer golden characterization (byte-for-byte)", () => {
	before(() => {
		initTheme("dark");
		process.stdout.columns = RENDER_WIDTH;
	});

	for (const c of CASES) {
		it(`renders ${c.name}`, () => {
			const output = renderCase(c);
			const file = goldenPath(c.name);
			if (UPDATE) {
				mkdirSync(GOLDEN_DIR, { recursive: true });
				writeFileSync(file, output + "\n", "utf8");
				return;
			}
			assert.ok(existsSync(file), `missing golden ${file} — run with GOLDEN_UPDATE=1 to create`);
			assert.equal(output + "\n", readFileSync(file, "utf8"), `golden mismatch for ${c.name}`);
		});
	}
});
