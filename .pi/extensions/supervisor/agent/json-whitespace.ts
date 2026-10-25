// ─── JSON whitespace skipping ───────────────────────────────────
// Scan forward/backward past whitespace. Split out of last-json-scanner.ts
// (issue #2033); the quote heuristic that uses it is json-close-heuristic.ts.

// ─── Smart Quote Detection ──────────────────────────────────────

/**
 * Skip whitespace characters (space, tab, newline, carriage return)
 * starting from index `i`. When `reverse` is true, scans backward.
 * Returns the index of the first non-whitespace character, or
 * `text.length` (forward) / `-1` (reverse) if all whitespace.
 */
export function skipWhitespace(text: string, i: number, reverse?: boolean): number {
	if (reverse) {
		while (
			i >= 0 &&
			(text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")
		) {
			i--;
		}
		return i;
	}
	while (
		i < text.length &&
		(text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")
	) {
		i++;
	}
	return i;
}

/**
 * Get the next non-whitespace character after position `i` in `text`.
 * Returns empty string if at end of text.
 */
export function nextNonWhitespace(text: string, i: number): string {
	return text[skipWhitespace(text, i + 1)] ?? "";
}
