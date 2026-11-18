// ─── Render Helpers ──────────────────────────────────────────────
// TUI rendering primitives used across multiple renderers.
// Separated from lib/formatting.ts to avoid coupling pure string
// formatting with TUI component dependencies (Container, Text, etc.).
//
// Plain-text tool-call formatting moved to lib/tool-call-text.ts (issue
// #2098): this module must not drag pi's tool factories into TUI-only
// consumers, and tool-call text must not pull pi-tui into plain-text consumers.

import { Text, Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ThemeColor, ThemeStyle } from "@earendil-works/pi-coding-agent";

/**
 * Minimal theme surface the render helpers need. `fg` takes `ThemeColor`
 * (not `string`) so both pi's real `Theme` and lenient test doubles with a
 * `string`-accepting `fg` remain assignable. `style` applies combined
 * attributes (fg/bg/bold/italic/…); `appearance` lets light/dark terminals
 * pick different tokens.
 */
export interface RenderTheme {
	fg: (color: ThemeColor, text: string) => string;
	style: (text: string, options: ThemeStyle) => string;
	appearance?: "dark" | "light";
}

/**
 * Structural container surface the render helpers need: any component that
 * accepts children (`Container`, `Box`, ...). Pi's `Container` and `Box` are
 * unrelated classes that both satisfy this, so the helpers stay usable with
 * either.
 */
export interface RenderContainer {
	addChild(component: Component): void;
}

/**
 * Appearance-aware subtle foreground token: `dim` is too faint on light
 * terminals, so `muted` is used there. Works with any object exposing pi's
 * `appearance` ("dark" | "light").
 */
export function subtleColor(theme: Pick<RenderTheme, "appearance">): ThemeColor {
	return theme.appearance === "light" ? "muted" : "dim";
}

/**
 * Render a thinking block (markdown content with thinkingText color + italic styling)
 * to match Pi's native assistant message thinking rendering.
 *
 * Creates a `Markdown` child with a `DefaultTextStyle` that applies `thinkingText`
 * color and italic styling, identical to how Pi's `assistant-message.js` renders
 * thinking traces.
 *
 * @param container - The TUI container to add children to (mutated in place)
 * @param text      - The thinking content (markdown-formatted text)
 * @param theme     - Theme object with a `fg` method matching TUI conventions
 */
export function renderThinkingBlock(
	container: RenderContainer,
	text: string,
	theme: RenderTheme,
): void {
	const mdTheme = getMarkdownTheme();
	container.addChild(
		new Markdown(text, 1, 1, mdTheme, {
			color: (t: string) => theme.style(t, { fg: "thinkingText" }),
			italic: true,
		}),
	);
}

/**
 * Render a list of text lines into a container, skipping empty/whitespace-only lines.
 *
 * Each non-empty line is styled with `theme.style(line, { fg: "dim" })` and
 * wrapped to `width` columns via `wrapTextWithAnsi`. Every wrapped segment is
 * added as a `Text` child.
 *
 * @param container - The TUI container to add children to (mutated in place)
 * @param lines     - Pre-split lines of text (caller owns split/truncation decisions)
 * @param theme     - Theme object with a `fg` method matching TUI conventions
 * @param width     - Maximum column width for text wrapping
 */
export function renderTextLines(
	container: RenderContainer,
	lines: string[],
	theme: RenderTheme,
	width: number,
): void {
	for (const line of lines) {
		if (!line.trim()) continue;
		const styled = theme.style(line, { fg: "dim" });
		for (const wrapped of wrapTextWithAnsi(styled, width)) {
			container.addChild(new Text(wrapped, 1, 0));
		}
	}
}
