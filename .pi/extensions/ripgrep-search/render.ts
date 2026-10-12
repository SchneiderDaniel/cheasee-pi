// ─── ripgrep-search: TUI renderers ───────────────────────────────
// Split out of index.ts (issue #2005 Long File refactor). renderCall/
// renderResult adapters + the OSC 8 hyperlink helper. index.ts re-exports
// these names.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getCtxMode } from "./internal.ts";

// ---------------------------------------------------------------------------
// Renderers — exported for testing
// ---------------------------------------------------------------------------

/** Render the tool call. */
export function renderCallImpl(
	args: { query: string; directory?: string },
	theme: Theme,
	_context: unknown,
): Text {
	const mode = getCtxMode();
	if (mode && mode !== "tui") {
		return new Text(args.query, 0, 0);
	}

	let text = theme.fg("toolTitle", theme.bold("rg "));
	text += theme.fg("accent", `"${args.query}"`);
	if (args.directory && args.directory !== ".") text += theme.fg("muted", ` in ${args.directory}`);
	return new Text(text, 0, 0);
}

/** Render the tool result. */
export function renderResultImpl(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
	},
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Theme,
	_context: unknown,
): Text {
	const { expanded, isPartial } = options;
	const mode = getCtxMode();

	// Non-TUI mode: pass through raw text content without theme
	if (mode && mode !== "tui") {
		const textContent = (result.content[0] as { text?: string })?.text ?? "";
		return new Text(textContent, 0, 0);
	}

	const d = result.details as
		| {
				total_returned?: number;
				searcher?: string;
				truncated?: boolean;
				fullOutputPath?: string;
				success?: boolean;
				searchDirectory?: string;
		  }
		| undefined;

	if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
	if (!d || d.success === false)
		return new Text(
			theme.fg("error", (result.content[0] as { text?: string })?.text ?? "Search failed"),
			0,
			0,
		);
	if (!d.total_returned) return new Text(theme.fg("dim", "No matches found"), 0, 0);

	let text = theme.fg("success", `${d.total_returned} matches`);
	text += theme.fg("muted", ` (${d.searcher ?? "?"})`);
	if (d.truncated) text += theme.fg("warning", " [truncated]");

	if (expanded) {
		const c = result.content[0] as { text?: string } | undefined;
		if (c?.text) {
			const lines = c.text.split("\n").slice(0, 20);
			for (const line of lines) {
				// Apply OSC 8 file:// hyperlink when searchDirectory is available
				const formattedLine = d.searchDirectory ? wrapOsc8Link(line, d.searchDirectory) : line;
				text += "\n" + theme.fg("dim", formattedLine);
			}
			if (c.text.split("\n").length > 20)
				text += "\n" + theme.fg("muted", "... (use read tool to see full output)");
		}
		if (d.fullOutputPath) text += "\n" + theme.fg("dim", `Full output: ${d.fullOutputPath}`);
	}

	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// OSC 8 hyperlink helper
// ---------------------------------------------------------------------------

/**
 * Wrap file path in a result line with an OSC 8 file:// hyperlink.
 *
 * Input format (from buildStructuredSummary):
 *   "1. file:line:column:text"
 * Output:
 *   "1. \x1b]8;;file:///path#L42\x1b\\file:42:16\x1b]8;;\x1b\\:text"
 */
export function wrapOsc8Link(line: string, searchDirectory: string): string {
	const resultLineRe = /^(\d+\.\s+)([^:]+):(\d+):(\d+):/;
	const match = line.match(resultLineRe);
	if (!match) return line;

	const [, prefix, file, lineNum] = match;
	const fileUrl = pathToFileURL(join(searchDirectory, file)).href + "#L" + lineNum;
	const osc8 = `\x1b]8;;${fileUrl}\x1b\\`;
	const osc8End = `\x1b]8;;\x1b\\`;

	// Build: "N. ${OSC8}file:line:column${OSC8_END}:text"
	const matchedPart = match[0]; // e.g. "1. src/app.ts:42:16:"
	const prefixLen = prefix.length; // "1. "
	const filePart = matchedPart.slice(prefixLen, -1); // "src/app.ts:42:16" (without trailing colon)
	return `${prefix}${osc8}${filePart}${osc8End}:${line.slice(matchedPart.length)}`;
}
