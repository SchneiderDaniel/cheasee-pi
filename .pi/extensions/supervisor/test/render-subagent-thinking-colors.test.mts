/**
 * First pin of the converged (canonical) thinking-level → color mapping in
 * render-subagent.ts, which now sources thinkingColor/thinkingLabel from
 * lib/thinking-level.ts instead of supervisor/lib/formatting.ts.
 *
 * The old supervisor colors (medium→muted, high→accent, xhigh→accent) had
 * zero test pins; this test pins the #1212-reconciled canonical mapping:
 *   medium→accent, high→warning, xhigh→error
 * and the unchanged dim/dim/muted for off/minimal/low. The footer thinking
 * fragment is emitted via theme.style; on light terminals the `dim` token is
 * swapped for the appearance-aware subtle token (`muted`).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/render-subagent-thinking-colors.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { renderSubagentResult } from "../session/message-renderers/render-subagent.ts";

interface StyleCall {
	fg: string | undefined;
	text: string;
}

/**
 * Render the expanded subagent-result view through a style-capturing theme.
 * Returns every style(text, { fg }) call whose text is exactly the thinking
 * label ("◒ medium" etc.) — only the expanded-footer stat matches exactly:
 * the collapsed stats line wraps the label inside a larger joined string.
 */
function renderExpandedThinkingStyleCalls(
	thinkingLevel: string | undefined,
	appearance?: "dark" | "light",
): StyleCall[] {
	const styleCalls: StyleCall[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		style: (text: string, options: any) => {
			styleCalls.push({ fg: options?.fg, text });
			return text;
		},
		...(appearance ? { appearance } : {}),
	};

	const message: Record<string, unknown> = {
		details: {
			eventType: "subagent-result",
			agentName: "dev-agent",
			content: [] as unknown[],
			details: {
				agentName: "dev-agent",
				success: true,
				statusLabel: "SUCCESS",
				summaryLine: "Done",
				model: "m",
				inputTokens: 0,
				outputTokens: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turnCount: 2,
				durationMs: 3000,
				thinkingLevel,
				toolCalls: [],
				toolResults: [],
				taskPrompt: "",
			},
		},
	};

	const component = renderSubagentResult(message as any, { expanded: true, outputPad: 0 }, theme as never, process.cwd());
	component!.render(80);
	return styleCalls;
}

function exactThinkingColor(level: string, appearance?: "dark" | "light"): string | undefined {
	const label = `${["○", "◐", "◑", "◒", "◓", "●"][["off", "minimal", "low", "medium", "high", "xhigh"].indexOf(level)]} ${level}`;
	const calls = renderExpandedThinkingStyleCalls(level, appearance).filter((c) => c.text === label);
	assert.strictEqual(calls.length, 1, `expected exactly one exact style call for '${label}'`);
	return calls[0]!.fg;
}

describe("render-subagent expanded footer thinking colors (canonical mapping)", () => {
	it("medium → accent (converged from muted)", () => {
		assert.strictEqual(exactThinkingColor("medium"), "accent");
	});

	it("high → warning (converged from accent)", () => {
		assert.strictEqual(exactThinkingColor("high"), "warning");
	});

	it("xhigh → error (converged from accent)", () => {
		assert.strictEqual(exactThinkingColor("xhigh"), "error");
	});

	it("off → dim (unchanged)", () => {
		assert.strictEqual(exactThinkingColor("off"), "dim");
	});

	it("minimal → dim (unchanged)", () => {
		assert.strictEqual(exactThinkingColor("minimal"), "dim");
	});

	it("low → muted (unchanged)", () => {
		assert.strictEqual(exactThinkingColor("low"), "muted");
	});

	it("undefined level → no thinking stat in footer", () => {
		const calls = renderExpandedThinkingStyleCalls(undefined);
		const icons = ["○", "◐", "◑", "◒", "◓", "●"];
		assert.ok(
			calls.every((c) => !icons.some((icon) => c.text.includes(icon))),
			"no thinking icon should be rendered when level is unset",
		);
	});

	it("light terminal: off/minimal dim → muted (appearance-aware subtle)", () => {
		assert.strictEqual(exactThinkingColor("off", "light"), "muted");
		assert.strictEqual(exactThinkingColor("minimal", "light"), "muted");
	});

	it("light terminal: semantic tokens unchanged", () => {
		assert.strictEqual(exactThinkingColor("medium", "light"), "accent");
		assert.strictEqual(exactThinkingColor("high", "light"), "warning");
		assert.strictEqual(exactThinkingColor("xhigh", "light"), "error");
	});
});