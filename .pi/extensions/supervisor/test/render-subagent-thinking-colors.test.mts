/**
 * First pin of the converged (canonical) thinking-level → color mapping in
 * render-subagent.ts, which now sources thinkingColor/thinkingLabel from
 * lib/thinking-level.ts instead of supervisor/lib/formatting.ts.
 *
 * The old supervisor colors (medium→muted, high→accent, xhigh→accent) had
 * zero test pins; this test pins the #1212-reconciled canonical mapping:
 *   medium→accent, high→warning, xhigh→error
 * and the unchanged dim/dim/muted for off/minimal/low.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/render-subagent-thinking-colors.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { renderSubagentResult } from "../session/message-renderers/render-subagent.ts";

interface FgCall {
	color: string;
	text: string;
}

/**
 * Render the expanded subagent-result view through a color-capturing theme.fg.
 * Returns every fg(color, text) call whose text is exactly the thinking
 * label ("◒ medium" etc.) — only the expanded-footer stat matches exactly:
 * the collapsed stats line wraps the label inside a larger joined string.
 */
function renderExpandedThinkingFgCalls(thinkingLevel: string | undefined): FgCall[] {
	const fgCalls: FgCall[] = [];
	const theme = {
		fg: (color: string, text: string) => {
			fgCalls.push({ color, text });
			return text;
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
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

	const component = renderSubagentResult(message as any, { expanded: true }, theme, process.cwd());
	component.render(80);
	return fgCalls;
}

function exactThinkingColor(level: string): string | undefined {
	const label = `${["○", "◐", "◑", "◒", "◓", "●"][["off", "minimal", "low", "medium", "high", "xhigh"].indexOf(level)]} ${level}`;
	const calls = renderExpandedThinkingFgCalls(level).filter((c) => c.text === label);
	assert.strictEqual(calls.length, 1, `expected exactly one exact fg call for '${label}'`);
	return calls[0]!.color;
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
		const calls = renderExpandedThinkingFgCalls(undefined);
		const icons = ["○", "◐", "◑", "◒", "◓", "●"];
		assert.ok(
			calls.every((c) => !icons.some((icon) => c.text.includes(icon))),
			"no thinking icon should be rendered when level is unset",
		);
	});
});