/**
 * explain.ts — Generic createExplainCommand factory for context-info
 *
 * Consolidates the duplicated /explain-extensions, /explain-prompts,
 * and /explain-skills command registrations into a single factory,
 * eliminating ~200 lines of nearly identical code.
 *
 * The `wordWrap` utility is also extracted here to avoid copy-paste
 * between explain-prompts and explain-skills.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── Word-wrap utility ────────────────────────────────────────────

/**
 * Word-wrap text to fit within maxWidth (measured in visible width).
 * Breaks at word boundaries where possible; hard-cuts when no space found.
 * Preserves as much of the original text as possible.
 */
export function wordWrap(text: string, maxWidth: number): string[] {
	if (visibleWidth(text) <= maxWidth) return [text];
	const result: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (visibleWidth(remaining) <= maxWidth) {
			result.push(remaining);
			break;
		}
		// Find last space within maxWidth
		let cut = maxWidth;
		while (cut > 0 && remaining[cut] !== " " && remaining[cut] !== undefined) {
			cut--;
		}
		if (cut <= 0) cut = maxWidth; // no space found, hard cut
		result.push(remaining.slice(0, cut).trimEnd());
		remaining = remaining.slice(cut).trimStart();
	}
	return result;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Shared formatItem that renders item name with accent on first line
 * and multi-line word-wrapped description with dim on subsequent lines.
 *
 * Extracted to eliminate duplication between /explain-prompts and
 * /explain-skills formatItem callbacks.
 */
export function formatWithWordWrap<T extends ExplainItem>(
	item: T,
	{ accent, dim, width }: FormatHelpers,
): string[] {
	const lines: string[] = [accent("  " + item.name)];
	const desc = (item.description ?? "(no description)").split("\n")[0]!.trim();
	const descWidth = Math.max(20, width - 6);
	const wrapped = wordWrap(desc, descWidth);
	for (const seg of wrapped) {
		lines.push(dim("    " + seg));
	}
	return lines;
}

// ─── Types ────────────────────────────────────────────────────────

/** Minimum shape an item needs for explain command rendering */
export interface ExplainItem {
	name: string;
	description?: string | null;
}

/** Formatting helpers passed to custom formatters */
export interface FormatHelpers {
	accent: (s: string) => string;
	dim: (s: string) => string;
	width: number;
}

/** Custom item formatter signature */
export type ItemFormatter<T> = (item: T, helpers: FormatHelpers) => string[];

/** Options for createExplainCommand */
export interface ExplainCommandOptions<T> {
	/** Custom item renderer. Default: "name  description" single line. */
	formatItem?: ItemFormatter<T>;
}

// ─── Factory ──────────────────────────────────────────────────────

/**
 * Create a /explain-* command that lists items with descriptions.
 *
 * @param pi - ExtensionAPI instance (for registerCommand)
 * @param commandName - e.g. "explain-prompts"
 * @param title - Singular item label, e.g. "prompt" → "prompts" in UI
 * @param listFn - Function returning items to display
 * @param options - Optional custom formatter
 */
export function createExplainCommand<T extends ExplainItem>(
	pi: ExtensionAPI,
	commandName: string,
	title: string,
	listFn: () => T[],
	options?: ExplainCommandOptions<T>,
): void {
	pi.registerCommand(commandName, {
		description: `List all project-local ${title}s with descriptions`,
		handler: async (_args, ctx: ExtensionContext) => {
			const items = listFn();
			if (items.length === 0) {
				ctx.ui.notify(`No ${title}s found`, "info");
				return;
			}

			ctx.ui.setWidget(commandName, (_tui, theme) => {
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);

				// Default formatter: single line "name  firstLineOfDescription"
				const defaultItemFormat: ItemFormatter<T> = (item, _helpers) => {
					const firstLine = (item.description ?? "(no description)").split("\n")[0].trim();
					return [accent("  " + item.name) + dim("  " + firstLine)];
				};

				const formatItem = options?.formatItem ?? defaultItemFormat;

				return {
					render: (width: number) => {
						const lines: string[] = [];
						const helpers: FormatHelpers = { accent, dim, width };

						for (const item of items) {
							const formatted = formatItem(item, helpers);
							for (const line of formatted) {
								lines.push(line);
							}
						}

						lines.push("");
						lines.push(
							dim("  ─ ") +
								dim(String(items.length)) +
								dim(` ${title}s ─ disappears when you type`),
						);

						return lines.map((line) => {
							if (line === "" || line.trim() === "") return "";
							return truncateToWidth(line, width);
						});
					},
					invalidate: () => {},
				};
			});
		},
	});
}
