/**
 * Tests: render-tool-complete.ts — theme.style() adoption.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/render-tool-complete-style.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderToolComplete } from "../session/message-renderers/render-tool-complete.ts";
import { makeTestTheme } from "./helpers/theme.mts";

before(() => {
	initTheme();
});

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		details: {
			eventType: "tool-complete",
			toolName: "bash",
			args: "ls",
			isError: false,
			toolIndex: "#1",
			toolDurationMs: 1200,
			runningToolCount: 1,
			maxToolCalls: 10,
			runningTokenCount: 500,
			agentTokenBudget: 100000,
			errorCount: 0,
			...overrides,
		},
	};
}

function render(overrides: Record<string, unknown> = {}) {
	const { theme, fgCalls, styleCalls } = makeTestTheme();
	const component = renderToolComplete(message(overrides) as never, {} as never, theme as never);
	component!.render(80); // triggers the Box per-line bg styling
	return { fgCalls, styleCalls };
}

describe("render-tool-complete theme.style adoption", () => {
	it("header tool name is styled with combined fg + bold via style()", () => {
		const { styleCalls } = render();
		assert.ok(
			styleCalls.some((c) => c.options.fg === "toolTitle" && c.options.bold === true),
			`expected a toolTitle+bold style call, got: ${JSON.stringify(styleCalls)}`,
		);
	});

	it("success status line uses style() for the background", () => {
		const { styleCalls } = render({ isError: false });
		assert.ok(
			styleCalls.some((c) => c.options.bg === "toolSuccessBg"),
			`expected toolSuccessBg style call, got: ${JSON.stringify(styleCalls)}`,
		);
	});

	it("error status line uses the error background", () => {
		const { styleCalls } = render({ isError: true, errorReason: "boom" });
		assert.ok(
			styleCalls.some((c) => c.options.bg === "toolErrorBg"),
			`expected toolErrorBg style call, got: ${JSON.stringify(styleCalls)}`,
		);
	});

	it("stats line is styled through style() with the muted token", () => {
		const { styleCalls } = render();
		assert.ok(
			styleCalls.some((c) => c.options.fg === "muted"),
			`expected a muted style call, got: ${JSON.stringify(styleCalls)}`,
		);
	});

	it("makes zero theme.fg calls (all migrated to style)", () => {
		const { fgCalls } = render({ resultText: "error: boom", thinking: "a thought" });
		assert.deepEqual(fgCalls, [], `expected no fg calls, got: ${JSON.stringify(fgCalls)}`);
	});

	it("icon and params use style with the expected tokens", () => {
		const { styleCalls } = render({ params: "--json", errorReason: "boom", isError: true });
		assert.ok(styleCalls.some((c) => c.options.fg === "error"));
		assert.ok(styleCalls.some((c) => c.options.fg === "warning"));
	});
});
