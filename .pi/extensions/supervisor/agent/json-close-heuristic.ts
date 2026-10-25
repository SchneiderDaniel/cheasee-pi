// ─── Structural-close heuristic ─────────────────────────────────
// Decide whether a `"` closes a JSON string value or is an unescaped content
// quote (markdown inside a commentBody). Split out of last-json-scanner.ts
// (issue #2033).

import { skipWhitespace } from "./json-whitespace.ts";

/**
 * Check if a double-quote at position `i` in `text` is a structural close
 * (end of JSON string value) or an unescaped content quote (e.g. markdown
 * "text" inside commentBody).
 *
 * Uses bidirectional heuristic:
 * 1. Lookahead: must be followed by `,`, `}`, `]`, or `:` after whitespace.
 * 2. Lookbehind: if preceded by a structural opener (`:`, `,`, `{`, `[`,
 *    or start-of-text), this `"` is an opening quote, not a close.
 *
 * This prevents false-positives when unescaped content quotes inside a
 * JSON string value happen to be followed by `,`, `}`, `]`, or `:`.
 * Example: `{"commentBody": "value: "key", is important"}` — the `"` before
 * `key` is preceded by ` ` (after `:`) → lookbehind sees `:` → opening quote.
 */
export function isStructuralClose(text: string, i: number): boolean {
	// Stage 1: Lookahead — must be followed by structural delimiter
	const j = skipWhitespace(text, i + 1);
	const next = j < text.length ? text[j] : "";
	if (next !== "," && next !== "}" && next !== "]" && next !== ":") return false;

	// Stage 2: Lookbehind — if preceded by structural opener, this is an opening quote
	const k = skipWhitespace(text, i - 1, true);
	const prev = k >= 0 ? text[k] : "";
	// Start-of-text, `:`, `,`, `{`, `[` mean this is an opening quote, not a close
	if (prev === "" || prev === ":" || prev === "," || prev === "{" || prev === "[") return false;

	return true;
}
