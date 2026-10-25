// ─── Metadata/tool-line filtering ───────────────────────────────
// Tool execution and debug markers pushed to fullLog by event handlers. Their
// content may contain `{`, `}` from tool args/results, which would corrupt
// brace counting, so they are removed before the JSON scan. Split out of
// last-json-scanner.ts (issue #2033).

import { isToolLine } from "../lib/tool-line.ts";

/** 🔧 ✓ ✗ 📋 📊 — the event-handler marker prefixes. */
const METADATA_LINE_RE = /^[\u{1F527}\u{2713}\u{2717}\u{1F4CB}\u{1F4CA}]/u;

/**
 * Drop metadata/tool lines when any are present; return the input unchanged
 * otherwise (the common case — most agent output carries no markers).
 */
export function stripMetadataLines(text: string, toolNames?: Set<string>): string {
	// Check if any filtering is needed (either old-format metadata lines or new-format tool call lines)
	const needsMetadataFilter = METADATA_LINE_RE.test(text);
	const needsToolCallFilter = text.split("\n").some((l) => isToolLine(l, toolNames));
	if (!needsMetadataFilter && !needsToolCallFilter) return text;

	const lines = text.split("\n");
	const filteredLines: string[] = [];
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (!METADATA_LINE_RE.test(trimmed) && !isToolLine(trimmed, toolNames)) {
			filteredLines.push(line);
		}
	}
	if (filteredLines.length > 0 && filteredLines.length < lines.length) {
		return filteredLines.join("\n");
	}
	return text;
}
