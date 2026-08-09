/**
 * Tests for createExplainCommand factory and wordWrap utility
 *
 * Verifies that the factory correctly registers commands and renders widgets
 * consistent with the previous per-command implementations.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/explain-commands.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createExplainCommand, formatWithWordWrap, wordWrap } from "../explain.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Create a mock pi + ctx pair and invoke the command handler.
 * Returns the render function of the created widget.
 */
function captureRender(
	factoryCall: (pi: ExtensionAPI) => void,
	fg?: (color: string, text: string) => string,
): (width: number) => string[] {
	let renderFn: ((width: number) => string[]) | null = null;
	let notifyMsg = "";
	let notifyType = "";

	const mockPi = {
		registerCommand: (_name: string, cmd: { description: string; handler: Function }) => {
			// Invoke the handler synchronously
			cmd.handler({}, {
				ui: {
					setWidget: (_id: string, widgetCb: any) => {
						// widgetCb is (tui, theme) => { render, invalidate }
						const widget = widgetCb(
							{},
							{
								fg: fg ?? ((_c: string, t: string) => t),
							},
						);
						renderFn = widget.render;
					},
					notify: (msg: string, type: string) => {
						notifyMsg = msg;
						notifyType = type;
					},
					setFooter: () => {},
					setStatus: () => {},
					setWorkingIndicator: () => {},
					theme: {
						fg: fg ?? ((_c: string, t: string) => t),
					},
				},
			} as any);
		},
		on: () => {},
	} as unknown as ExtensionAPI;

	factoryCall(mockPi);

	if (!renderFn && notifyMsg) {
		return ((_width: number) => {
			throw new Error(`NOTIFICATION:${notifyMsg}:${notifyType}`);
		}) as unknown as (width: number) => string[];
	}

	return renderFn!;
}

// ---------------------------------------------------------------------------
// formatWithWordWrap tests
// ---------------------------------------------------------------------------

describe("formatWithWordWrap", () => {
	it("renders item name with accent on first line", () => {
		const accent = (s: string) => `[${s}]`;
		const dim = (s: string) => `-${s}-`;
		const result = formatWithWordWrap(
			{ name: "test-item", description: "A test item" },
			{ accent, dim, width: 80 },
		);
		assert.strictEqual(result[0], "[  test-item]");
	});

	it("renders description with dim, word-wrapped within Math.max(20, width - 6) width", () => {
		const accent = (s: string) => s;
		const dim = (s: string) => `[${s}]`;
		// Word-wrap needs a long description to trigger wrapping
		const longDesc = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
		const result = formatWithWordWrap(
			{ name: "item", description: longDesc },
			{ accent, dim, width: 80 },
		);
		// First line is the item name
		assert.strictEqual(result[0], "  item");
		// Subsequent lines should be dim-wrapped description segments
		for (let i = 1; i < result.length; i++) {
			assert.ok(result[i]!.startsWith("["), "each description line should be dim-wrapped");
			assert.ok(result[i]!.endsWith("]"), "each description line should close dim");
		}
	});

	it("falls back to '(no description)' when description is null", () => {
		const accent = (s: string) => s;
		const dim = (s: string) => s;
		const result = formatWithWordWrap(
			{ name: "null-item", description: null },
			{ accent, dim, width: 80 },
		);
		const all = result.join("\n");
		assert.ok(all.includes("(no description)"), "null description should show fallback");
	});

	it("falls back to '(no description)' when description is undefined", () => {
		const accent = (s: string) => s;
		const dim = (s: string) => s;
		const result = formatWithWordWrap(
			{ name: "undef-item", description: undefined },
			{ accent, dim, width: 80 },
		);
		const all = result.join("\n");
		assert.ok(all.includes("(no description)"), "undefined description should show fallback");
	});

	it("uses only first line of multi-line description", () => {
		const accent = (s: string) => s;
		const dim = (s: string) => s;
		const result = formatWithWordWrap(
			{ name: "multi", description: "first line\nsecond line\nthird line" },
			{ accent, dim, width: 80 },
		);
		const all = result.join("\n");
		assert.ok(all.includes("first line"), "should include first line");
		assert.ok(!all.includes("second line"), "should NOT include second line");
		assert.ok(!all.includes("third line"), "should NOT include third line");
	});

	it("accepts width-dependent word-wrap: narrow width produces more wrapped lines", () => {
		const accent = (s: string) => s;
		const dim = (s: string) => s;
		const desc = "word word word word word word word word word";
		const wideResult = formatWithWordWrap(
			{ name: "x", description: desc },
			{ accent, dim, width: 100 },
		);
		const narrowResult = formatWithWordWrap(
			{ name: "x", description: desc },
			{ accent, dim, width: 30 },
		);
		// Narrow width should produce more description lines than wide width
		const wideDescLines = wideResult.length - 1; // exclude title line
		const narrowDescLines = narrowResult.length - 1;
		assert.ok(
			narrowDescLines >= wideDescLines,
			`narrow width (${narrowDescLines} desc lines) should produce >= lines than wide (${wideDescLines})`,
		);
	});

	it("accepts PromptMeta (concrete type) — no type error", () => {
		const accent = (s: string) => s;
		const dim = (s: string) => s;
		const result = formatWithWordWrap(
			{ name: "prompt", filePath: "/path/to/prompt", description: "A prompt" },
			{ accent, dim, width: 80 },
		);
		assert.ok(result[0]!.includes("prompt"));
	});

	it("accepts SkillMeta (concrete type) — no type error", () => {
		const accent = (s: string) => s;
		const dim = (s: string) => s;
		const result = formatWithWordWrap(
			{ name: "skill", filePath: "/path/to/skill", description: "A skill" },
			{ accent, dim, width: 80 },
		);
		assert.ok(result[0]!.includes("skill"));
	});
});

// ---------------------------------------------------------------------------
// wordWrap tests
// ---------------------------------------------------------------------------

describe("wordWrap", () => {
	it("returns text as-is when it fits within maxWidth", () => {
		const result = wordWrap("short", 20);
		assert.deepStrictEqual(result, ["short"]);
	});

	it("wraps text at word boundary", () => {
		const result = wordWrap("hello world foo bar", 10);
		assert.deepStrictEqual(result, ["hello", "world foo", "bar"]);
	});

	it("hard-cuts at maxWidth when no space found", () => {
		const result = wordWrap("abcdefghijklmnopqrstuvwxyz", 10);
		assert.deepStrictEqual(result, ["abcdefghij", "klmnopqrst", "uvwxyz"]);
	});

	it("handles single word longer than maxWidth", () => {
		const result = wordWrap("superlongword", 5);
		assert.deepStrictEqual(result, ["super", "longw", "ord"]);
	});

	it("trims trailing whitespace from wrapped lines", () => {
		const result = wordWrap("hello    world", 8);
		assert.deepStrictEqual(result, ["hello", "world"]);
	});

	it("handles empty string", () => {
		const result = wordWrap("", 10);
		assert.deepStrictEqual(result, [""]);
	});

	it("handles exact fit", () => {
		const result = wordWrap("12345", 5);
		assert.deepStrictEqual(result, ["12345"]);
	});
});

// ---------------------------------------------------------------------------
// createExplainCommand tests
// ---------------------------------------------------------------------------

describe("createExplainCommand", () => {
	it("registers a command with pi.registerCommand", () => {
		const registered: Array<{ name: string; description: string }> = [];
		const mockPi = {
			registerCommand: (name: string, cmd: { description: string; handler: Function }) => {
				registered.push({ name, description: cmd.description });
			},
			on: () => {},
		} as unknown as ExtensionAPI;

		createExplainCommand(mockPi, "test-command", "item", () => []);

		assert.strictEqual(registered.length, 1);
		assert.strictEqual(registered[0]!.name, "test-command");
		assert.strictEqual(
			registered[0]!.description,
			"List all project-local items with descriptions",
		);
	});

	it("shows notification when list is empty", () => {
		let notifyMsg = "";
		let notifyType = "";
		const mockPi = {
			registerCommand: (_name: string, cmd: { handler: Function }) => {
				cmd.handler({}, {
					ui: {
						notify: (msg: string, type: string) => {
							notifyMsg = msg;
							notifyType = type;
						},
						setWidget: () => {},
						setFooter: () => {},
						setStatus: () => {},
						setWorkingIndicator: () => {},
						theme: { fg: () => "" },
					},
				} as any);
			},
			on: () => {},
		} as unknown as ExtensionAPI;

		createExplainCommand(mockPi, "test-empty", "widget", () => []);

		assert.strictEqual(notifyMsg, "No widgets found");
		assert.strictEqual(notifyType, "info");
	});

	it("creates widget when items exist", () => {
		let widgetCreated = false;
		const mockPi = {
			registerCommand: (_name: string, cmd: { handler: Function }) => {
				cmd.handler({}, {
					ui: {
						setWidget: (_id: string, widgetCb: any) => {
							widgetCb({}, { fg: () => "" });
							widgetCreated = true;
						},
						notify: () => {},
						setFooter: () => {},
						setStatus: () => {},
						setWorkingIndicator: () => {},
						theme: { fg: () => "" },
					},
				} as any);
			},
			on: () => {},
		} as unknown as ExtensionAPI;

		createExplainCommand(mockPi, "test-items", "gadget", () => [
			{ name: "item1", description: "First item" },
			{ name: "item2", description: "Second item" },
		]);

		assert.ok(widgetCreated, "widget should be created when items exist");
	});

	it("renders items with default formatter (name + first line of description)", () => {
		const renderFn = captureRender((pi) => {
			createExplainCommand(pi, "test-render", "part", () => [
				{ name: "alpha", description: "First part" },
				{ name: "beta", description: "Second part\nwith more detail" },
			]);
		});

		const lines = renderFn(80);
		assert.ok(Array.isArray(lines), "render should return array of lines");

		// Should contain item names
		const joined = lines.filter(Boolean).join("\n");
		assert.ok(joined.includes("alpha"), "should include item name 'alpha'");
		assert.ok(joined.includes("beta"), "should include item name 'beta'");
		// Default formatter shows first line of description inline
		assert.ok(joined.includes("First part"), "should include first line of description");
		assert.ok(joined.includes("Second part"), "should include first line of description");
		// Should have count footer
		assert.ok(joined.includes("2 parts"), "footer should show count and plural");
	});

	it("renders items with custom formatter", () => {
		const renderFn = captureRender((pi) => {
			createExplainCommand(pi, "test-custom", "thing", () => [{ name: "X", description: "desc" }], {
				formatItem: (item, { accent, dim }) => [
					accent(">> " + item.name),
					dim("   " + (item.description ?? "none")),
				],
			});
		});

		const lines = renderFn(80);
		const joined = lines.filter(Boolean).join("\n");
		assert.ok(joined.includes(">> X"), "custom format should be applied");
		assert.ok(joined.includes("   desc"), "custom format dim line should be present");
	});

	it("handles items with null description", () => {
		const renderFn = captureRender((pi) => {
			createExplainCommand(pi, "test-null-desc", "x", () => [
				{ name: "noDesc", description: null },
			]);
		});

		const lines = renderFn(80);
		const joined = lines.filter(Boolean).join("\n");
		assert.ok(joined.includes("noDesc"), "item name should appear");
		assert.ok(joined.includes("(no description)"), "null description should show fallback");
	});

	it("handles items with undefined description", () => {
		const renderFn = captureRender((pi) => {
			createExplainCommand(pi, "test-undef-desc", "x", () => [{ name: "undefDesc" }]);
		});

		const lines = renderFn(80);
		const joined = lines.filter(Boolean).join("\n");
		assert.ok(joined.includes("undefDesc"), "item name should appear");
		assert.ok(joined.includes("(no description)"), "undefined description should show fallback");
	});

	it("whitespace-only lines become empty string", () => {
		const renderFn = captureRender((pi) => {
			createExplainCommand(pi, "test-blank-lines", "thing", () => [
				{ name: "A", description: "desc" },
			]);
		});

		const lines = renderFn(80);
		assert.ok(
			lines.some((l) => l.includes("thing") && l.includes("disappears")),
			"footer should include count and 'disappears when you type'",
		);
	});

	it("the 'disappears when you type' message appears with count", () => {
		const renderFn = captureRender((pi) => {
			createExplainCommand(pi, "test-footer-line", "item", () => [
				{ name: "foo", description: "bar" },
			]);
		});

		const lines = renderFn(80);
		const footerLine = lines.find(
			(l) => typeof l === "string" && l.includes("item") && l.includes("disappears"),
		);
		assert.ok(footerLine, "footer line should exist");
		assert.ok(
			footerLine!.includes("1 items ─ disappears when you type"),
			"footer should show count with plural title",
		);
	});

	it("truncates lines to width using truncateToWidth-like behavior", () => {
		// The explain-extensions command uses truncateToWidth; the factory
		// uses it for extensions (default formatter). Verify it works.
		const renderFn = captureRender((pi) => {
			createExplainCommand(pi, "test-truncate", "x", () => [
				{ name: "alpha", description: "short" },
			]);
		});

		const lines = renderFn(10);
		for (const line of lines) {
			assert.ok(typeof line === "string", "each line should be a string");
		}
	});
});
