/**
 * ask-user — scrollable question dialog
 *
 * Renders a custom TUI dialog with a scrollable question text area (PgUp/PgDn)
 * and a SelectList for option navigation (↑↓ arrows). Wraps ctx.ui.custom().
 *
 * No fs coupling. Depends on @earendil-works/pi-tui for UI primitives.
 */

import {
	getKeybindings,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Max visible lines for the question area before scrolling kicks in. */
const MAX_QUESTION_LINES = 12;
/** Number of lines to scroll per PgUp/PgDn press. */
const QUESTION_SCROLL_STEP = 5;

/**
 * Render a scrollable question dialog with selectable options.
 *
 * @param tui  - TUI instance from ctx.ui.custom
 * @param theme - Theme from ctx.ui.custom
 * @param done - Callback from ctx.ui.custom
 * @param question - The question text (may contain code blocks)
 * @param items - SelectList items
 */
export function renderScrollableDialog(
	tui: {
		requestRender: () => void;
	},
	theme: {
		fg: (color: string, text: string) => string;
	},
	done: (value: string | undefined) => void,
	question: string,
	items: SelectItem[],
): {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
} {
	let questionScrollOffset = 0;

	const selectListTheme: SelectListTheme = {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	};

	const selectList = new SelectList(items, Math.min(items.length, 10), selectListTheme);
	selectList.onSelect = (item) => done(item.value);
	selectList.onCancel = () => done(undefined);

	const borderColor = (s: string) => theme.fg("border", s);

	return {
		render(width: number): string[] {
			const lines: string[] = [];

			// Wrap question to current width (leave 4 cols for padding)
			const qLines = wrapTextWithAnsi(question, Math.max(10, width - 4));

			// Clamp scroll offset in case terminal was resized
			const maxOffset = Math.max(0, qLines.length - MAX_QUESTION_LINES);
			if (questionScrollOffset > maxOffset) {
				questionScrollOffset = maxOffset;
			}
			if (questionScrollOffset < 0) {
				questionScrollOffset = 0;
			}

			const visibleQLines = qLines.slice(
				questionScrollOffset,
				questionScrollOffset + MAX_QUESTION_LINES,
			);

			// Top border
			lines.push(borderColor("─".repeat(Math.max(1, width))));
			lines.push("");

			// Scroll indicator at top
			if (questionScrollOffset > 0) {
				lines.push(theme.fg("dim", "  ▲ more above (PgUp to scroll)"));
			}

			// Question lines
			for (const line of visibleQLines) {
				lines.push("  " + line);
			}

			// Scroll indicator at bottom of question area
			if (questionScrollOffset + MAX_QUESTION_LINES < qLines.length) {
				lines.push(theme.fg("dim", "  ▼ more below (PgDn to scroll)"));
			}

			lines.push("");

			// Options via SelectList
			const listLines = selectList.render(width);
			for (const line of listLines) {
				lines.push(line);
			}

			lines.push("");
			lines.push(
				theme.fg("dim", "  ↑↓ navigate  enter select  esc cancel  PgUp/PgDn scroll question"),
			);
			lines.push("");
			lines.push(borderColor("─".repeat(Math.max(1, width))));

			return lines;
		},

		invalidate() {
			questionScrollOffset = 0;
			selectList.invalidate();
		},

		handleInput(data: string) {
			const kb = getKeybindings();

			// PgUp — scroll question up
			if (kb.matches(data, "tui.select.pageUp")) {
				questionScrollOffset = Math.max(0, questionScrollOffset - QUESTION_SCROLL_STEP);
				tui.requestRender();
				return;
			}

			// PgDn — scroll question down
			if (kb.matches(data, "tui.select.pageDown")) {
				questionScrollOffset += QUESTION_SCROLL_STEP;
				tui.requestRender();
				return;
			}

			// Forward everything else to SelectList (arrows, enter, escape, etc.)
			selectList.handleInput(data);
			tui.requestRender();
		},
	};
}
