// ─── Render Helpers ──────────────────────────────────────────────
// TUI rendering primitives used across multiple renderers.
// Separated from lib/formatting.ts to avoid coupling pure string
// formatting with TUI component dependencies (Container, Text, etc.).

import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Container } from "@earendil-works/pi-tui";

/**
 * Render a list of text lines into a container, skipping empty/whitespace-only lines.
 *
 * Each non-empty line is styled with `theme.fg("dim", line)` and wrapped to `width`
 * columns via `wrapTextWithAnsi`. Every wrapped segment is added as a `Text` child.
 *
 * @param container - The TUI container to add children to (mutated in place)
 * @param lines     - Pre-split lines of text (caller owns split/truncation decisions)
 * @param theme     - Theme object with a `fg` method matching TUI conventions
 * @param width     - Maximum column width for text wrapping
 */
export function renderTextLines(
	container: Container,
	lines: string[],
	theme: { fg: (color: string, text: string) => string },
	width: number,
): void {
	for (const line of lines) {
		if (!line.trim()) continue;
		const styled = theme.fg("dim", line);
		for (const wrapped of wrapTextWithAnsi(styled, width)) {
			container.addChild(new Text(wrapped, 1, 0));
		}
	}
}
