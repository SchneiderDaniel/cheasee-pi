/**
 * Tests: render-helpers.ts — renderTextLines unit tests.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/render-helpers.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Container, Text, Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderTextLines, renderThinkingBlock } from "../lib/render-helpers.ts";

// ─── Fixtures ────────────────────────────────────────────────────

const mockTheme = {
	fg: (_color: string, text: string) => text,
};

/** Tracking theme that records fg() calls */
function makeTrackingTheme() {
	const calls: Array<{ color: string; text: string }> = [];
	const theme = {
		fg: (color: string, text: string) => {
			calls.push({ color, text });
			return text;
		},
	};
	return { theme, calls };
}

/**
 * Preserve ANSI codes for italic verification.
 */
function renderRaw(container: Container, width = 80): string[] {
	return container.render(width);
}

/**
 * Check if any line contains italic ANSI code (\x1b[3m).
 */
function hasItalic(lines: string[]): boolean {
	return lines.some((l) => l.includes("\x1b[3m"));
}

/** Strip ANSI escape sequences from a string */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[\d+m/g, "").replace(/\x1b\[0m/g, "");
}

/**
 * Render a Container to an array of stripped text lines.
 * Note: Text.render(width) pads output to full width with leading space.
 * Use .trim() for content comparisons unless checking padding behavior.
 */
function renderStripped(container: Container, width = 80): string[] {
	const raw = container.render(width);
	return raw.map((line: string) => stripAnsi(line).trim());
}

// ─── Tests ───────────────────────────────────────────────────────

describe("renderTextLines", () => {
	it("happy path: renders two non-empty lines as Text children", () => {
		const c = new Container();
		renderTextLines(c, ["hello", "world"], mockTheme, 80);
		const lines = renderStripped(c);
		assert.equal(lines.length, 2);
		assert.equal(lines[0], "hello");
		assert.equal(lines[1], "world");
	});

	it("empty lines array adds zero children", () => {
		const c = new Container();
		renderTextLines(c, [], mockTheme, 80);
		const lines = renderStripped(c);
		assert.equal(lines.length, 0);
	});

	it("all empty/whitespace-only lines are skipped — zero children", () => {
		const c = new Container();
		renderTextLines(c, ["", "  ", "\t", "   "], mockTheme, 80);
		const lines = renderStripped(c);
		assert.equal(lines.length, 0);
	});

	it("single non-empty line adds one Text child", () => {
		const c = new Container();
		renderTextLines(c, ["single"], mockTheme, 80);
		const lines = renderStripped(c);
		assert.equal(lines.length, 1);
		assert.equal(lines[0], "single");
	});

	it("mixed content: only non-empty lines produce children", () => {
		const c = new Container();
		renderTextLines(c, ["first", "", "  ", "second", "\t"], mockTheme, 80);
		const lines = renderStripped(c);
		assert.equal(lines.length, 2);
		assert.equal(lines[0], "first");
		assert.equal(lines[1], "second");
	});

	it("width parameter is forwarded to wrapTextWithAnsi — long lines wrap", () => {
		const c = new Container();
		const longLine = "a".repeat(200);
		renderTextLines(c, [longLine], mockTheme, 20);
		const lines = renderStripped(c);
		// At width=20, each wrapped segment is at most 20 chars
		assert.ok(lines.length >= 10, `expected at least 10 wrapped lines, got ${lines.length}`);
		for (const line of lines) {
			assert.ok(
				line.length <= 20,
				`wrapped segment should be ≤20 chars, got: "${line}" (${line.length})`,
			);
		}
	});

	it("theme.fg('dim', ...) is applied to each non-empty line", () => {
		const trackTheme = {
			fg: (color: string, text: string) => {
				assert.equal(color, "dim", `expected "dim" color, got "${color}"`);
				return `styled:${text}`;
			},
		};
		const c = new Container();
		renderTextLines(c, ["alpha", "beta"], trackTheme, 80);
		const lines = renderStripped(c);
		assert.equal(lines.length, 2);
		assert.ok(lines[0].includes("styled:alpha"), `expected styled:alpha, got: ${lines[0]}`);
		assert.ok(lines[1].includes("styled:beta"), `expected styled:beta, got: ${lines[1]}`);
	});

	it("container mutability: appends to existing children", () => {
		const c = new Container();
		c.addChild(new Text("existing", 1, 0));
		renderTextLines(c, ["new1", "new2"], mockTheme, 80);
		const lines = renderStripped(c);
		assert.equal(lines.length, 3);
		assert.equal(lines[0], "existing");
		assert.equal(lines[1], "new1");
		assert.equal(lines[2], "new2");
	});

	it("interop: wrapTextWithAnsi produces same output as direct call", () => {
		// Verify the internal wrap behavior matches expectations
		const styled = mockTheme.fg("dim", "hello world");
		const wrapped = [...wrapTextWithAnsi(styled, 80)];
		assert.deepEqual(wrapped, ["hello world"]);
	});
});

// ─── Phase 2: renderThinkingBlock ───────────────────────────────

describe("renderThinkingBlock", () => {
	before(() => {
		initTheme();
	});

	it("creates a Markdown child with thinkingText + italic DefaultTextStyle", () => {
		const { theme } = makeTrackingTheme();
		const c = new Container();
		renderThinkingBlock(c, "hello thinking", theme);
		const children = (c as any).children || [];
		assert.ok(
			children.some((child: any) => child instanceof Markdown),
			"should add a Markdown child",
		);
	});

	it("uses theme.fg('thinkingText', …) via DefaultTextStyle", () => {
		const { theme, calls } = makeTrackingTheme();
		const c = new Container();
		renderThinkingBlock(c, "test text", theme);
		// DefaultTextStyle.color function is called per-text-element during render
		const raw = renderRaw(c);
		assert.ok(
			calls.some((call) => call.color === "thinkingText"),
			`expected "thinkingText" call, got: ${JSON.stringify(calls)}`,
		);
	});

	it("passes italic: true to Markdown DefaultTextStyle", () => {
		const c = new Container();
		renderThinkingBlock(c, "italic text", mockTheme);
		const children = (c as any).children || [];
		const md = children.find((child: any) => child instanceof Markdown);
		assert.ok(md, "should have a Markdown child");
		assert.equal(md.defaultTextStyle?.italic, true, "DefaultTextStyle.italic should be true");
	});

	it("appends to existing children", () => {
		const c = new Container();
		c.addChild(new Text("existing", 1, 0));
		renderThinkingBlock(c, "new thinking", mockTheme);
		const lines = renderStripped(c);
		assert.ok(
			lines.some((l) => l.includes("existing")),
			"should contain existing text",
		);
		assert.ok(
			lines.some((l) => l.includes("new thinking")),
			"should contain thinking text",
		);
	});

	it("long thinking text wraps at terminal width (Markdown handles wrapping)", () => {
		const c = new Container();
		const longText = "a".repeat(200);
		renderThinkingBlock(c, longText, mockTheme);
		const lines = renderRaw(c, 20);
		// Each line should be ≤ 20 chars (wrapped)
		for (const line of lines) {
			const stripped = line.replace(/\x1b\[\d+m/g, "");
			// Allow first/last lines that may have padding
			if (stripped.trim())
				assert.ok(
					stripped.trim().length <= 20,
					`expected line ≤20 chars, got: "${stripped}" (${stripped.trim().length})`,
				);
		}
	});

	it("empty string renders as Markdown (not skipped)", () => {
		const c = new Container();
		renderThinkingBlock(c, "", mockTheme);
		const children = (c as any).children || [];
		assert.ok(
			children.some((child: any) => child instanceof Markdown),
			"should add Markdown child even for empty string",
		);
	});

	it("does not mutate theme object", () => {
		const originalTheme = { fg: (_c: string, t: string) => t };
		const frozen = Object.freeze({ ...originalTheme });
		const c = new Container();
		renderThinkingBlock(c, "test", frozen);
		const children = (c as any).children || [];
		assert.equal(children.length, 1, "should add exactly one child");
	});
});
