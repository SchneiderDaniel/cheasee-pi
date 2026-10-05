/**
 * Tests: render-subagent.ts — nestedCalls summary line.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/render-subagent-nested-calls.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { renderSubagentResult } from "../session/message-renderers/render-subagent.ts";
import type { SubagentDetails, NestedCalls } from "../subagent/types.ts";
import { makeTestTheme } from "./helpers/theme.mts";

process.stdout.columns = 100;

function details(overrides: Partial<SubagentDetails> = {}): SubagentDetails {
	return {
		agentName: "developer",
		success: true,
		statusLabel: "SUCCESS",
		summaryLine: "Done",
		model: "anthropic/claude-sonnet-4",
		inputTokens: 100,
		outputTokens: 200,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.01,
		turnCount: 3,
		durationMs: 4200,
		toolCalls: [],
		toolResults: [],
		taskPrompt: "",
		...overrides,
	};
}

function message(d: SubagentDetails): Record<string, unknown> {
	return {
		details: {
			eventType: "subagent-result",
			agentName: d.agentName,
			content: [],
			details: d,
		},
	};
}

function render(d: SubagentDetails, expanded = true, theme = makeTestTheme().theme): string {
	const component = renderSubagentResult(
		message(d) as never,
		{ expanded, outputPad: 0 } as never,
		theme as never,
		process.cwd(),
	);
	return component!.render(90).join("\n");
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("render-subagent nestedCalls summary", () => {
	before(() => {
		process.stdout.columns = 100;
	});

	it("expanded + nested calls → compact summary line", () => {
		const nested: NestedCalls = {
			calls: [
				{ name: "read", status: "ok" },
				{ name: "grep", status: "ok" },
				{ name: "bash", status: "error" },
			],
			complete: true,
		};
		const out = stripAnsi(render(details({ nestedCalls: nested })));
		assert.match(out, /nested: 3 calls \(2 ok, 1 err\)/);
		assert.ok(!out.includes("truncated"), "complete:true must not mark truncation");
	});

	it("single nested call uses singular noun", () => {
		const out = stripAnsi(
			render(details({ nestedCalls: { calls: [{ name: "read", status: "ok" }], complete: true } })),
		);
		assert.match(out, /nested: 1 call \(1 ok, 0 err\)/);
	});

	it("complete:false flags truncation", () => {
		const out = stripAnsi(
			render(details({ nestedCalls: { calls: [{ name: "read", status: "ok" }], complete: false } })),
		);
		assert.match(out, /nested: 1 call \(1 ok, 0 err\) \(truncated\)/);
	});

	it("empty calls with complete:true renders no nested line", () => {
		const out = stripAnsi(render(details({ nestedCalls: { calls: [], complete: true } })));
		assert.ok(!/nested/.test(out), "empty calls must not render a nested line");
	});

	it("nestedCalls omitted renders no nested output", () => {
		const out = stripAnsi(render(details()));
		assert.ok(!out.includes("nested:"), "absent nestedCalls must render nothing");
	});

	it("collapsed view is byte-identical with and without nestedCalls", () => {
		const without = render(details(), false);
		const withNested = render(
			details({ nestedCalls: { calls: [{ name: "read", status: "ok" }], complete: true } }),
			false,
		);
		assert.equal(withNested, without);
		assert.ok(!/nested/.test(stripAnsi(withNested)));
	});

	it("expanded bytes identical when nestedCalls omitted vs undefined", () => {
		const without = render(details());
		const undef = render(details({ nestedCalls: undefined }));
		assert.equal(undef, without);
	});

	it("nested errors counted in status/error summary when nestedCalls present", () => {
		const out = stripAnsi(
			render(
				details({
					errorCount: 2,
					nestedCalls: {
						calls: [
							{ name: "bash", status: "error" },
							{ name: "grep", status: "error" },
						],
						complete: true,
					},
				}),
			),
		);
		assert.match(out, /2 err/);
	});

	it("unfinished call shows an unfinished segment without inflating err", () => {
		const out = stripAnsi(
			render(
				details({
					nestedCalls: {
						calls: [
							{ name: "read", status: "ok" },
							{ name: "bash", status: "unfinished" },
						],
						complete: true,
					},
				}),
			),
		);
		assert.match(out, /nested: 2 calls \(1 ok, 0 err, 1 unfinished\)/);
	});

	it("expanded render shows exactly one standalone error segment", () => {
		const out = stripAnsi(
			render(
				details({
					errorCount: 2,
					nestedCalls: {
						calls: [
							{ name: "bash", status: "error" },
							{ name: "grep", status: "error" },
						],
						complete: true,
					},
				}),
			),
		);
		// Drop the nested summary line; any remaining `N err` is a standalone surface.
		const withoutNested = out
			.split("\n")
			.filter((l) => !l.includes("nested:"))
			.join("\n");
		const standalone = withoutNested.match(/\d+ err/g) ?? [];
		assert.equal(standalone.length, 1, `expected 1 standalone err segment, got: ${JSON.stringify(standalone)}`);
		assert.match(withoutNested, /2 err/);
	});

	it("errorCount without nestedCalls yields exactly one err segment (guard dropped)", () => {
		const out = stripAnsi(render(details({ errorCount: 2 })));
		const standalone = out.split("\n").filter((l) => /\d+ err/.test(l));
		assert.equal(standalone.length, 1, `expected one err line, got: ${JSON.stringify(standalone)}`);
		assert.match(out, /2 err/);
	});

	it("errorCount absent → no err segment in collapsed or expanded", () => {
		const out = stripAnsi(render(details()));
		assert.ok(!/\d+ err/.test(out), "no errorCount must not render an err segment");
	});

	it("errorCount:0 with nestedCalls present → no standalone err segment", () => {
		const out = stripAnsi(
			render(
				details({
					errorCount: 0,
					nestedCalls: { calls: [{ name: "read", status: "ok" }], complete: true },
				}),
			),
		);
		assert.ok(!/^\s*0 err\s*$/m.test(out), "errorCount 0 must not render a standalone err line");
	});
});

describe("render-subagent subtle styling is appearance-aware", () => {
	it("light appearance styles subtle text with muted, never dim", () => {
		const { theme, fgCalls, styleCalls } = makeTestTheme({ appearance: "light" });
		render(
			details({ nestedCalls: { calls: [{ name: "read", status: "ok" }], complete: true } }),
			true,
			theme as never,
		);
		assert.ok(
			styleCalls.some((c) => c.options.fg === "muted"),
			`expected a muted style call, got: ${JSON.stringify(styleCalls)}`,
		);
		assert.ok(
			!styleCalls.some((c) => c.options.fg === "dim"),
			`light appearance must not use dim, got: ${JSON.stringify(styleCalls)}`,
		);
		assert.ok(
			!fgCalls.some((c) => c.color === "dim"),
			`light appearance must not fg dim: ${JSON.stringify(fgCalls)}`,
		);
	});

	it("dark appearance styles subtle text with dim", () => {
		const { theme, styleCalls } = makeTestTheme({ appearance: "dark" });
		render(
			details({ nestedCalls: { calls: [{ name: "read", status: "ok" }], complete: true } }),
			true,
			theme as never,
		);
		assert.ok(
			styleCalls.some((c) => c.options.fg === "dim"),
			`expected a dim style call, got: ${JSON.stringify(styleCalls)}`,
		);
	});

	it("status icon/text use theme.style with the status token", () => {
		const { theme, styleCalls } = makeTestTheme();
		render(details(), true, theme as never);
		assert.ok(
			styleCalls.some((c) => c.text === "✓" && c.options.fg === "success"),
			JSON.stringify(styleCalls),
		);
		assert.ok(
			styleCalls.some((c) => c.text === "SUCCESS" && c.options.fg === "success"),
			JSON.stringify(styleCalls),
		);
	});
});
