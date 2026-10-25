// ─── JSON Sanitization ────────────────────────────────────────────
// Escape literal newlines inside JSON string values, and the conservative
// content-quote retry fallback. Split out of last-json-scanner.ts (#2033).

import { walkJsonChars } from "./json-string-state.ts";
import { isStructuralClose } from "./json-close-heuristic.ts";
import { nextNonWhitespace, skipWhitespace } from "./json-whitespace.ts";

/**
 * Escape literal newlines (\\n, \\r) inside JSON string values.
 * Agents often produce JSON where commentBody contains actual newlines
 * instead of \\n escape sequences. This makes JSON.parse fail.
 *
 * Edge cases handled:
 * - Escaped quotes (\\") inside strings
 * - Backslash-escaped characters (\\\\, \\n, etc.)
 * - Nested JSON objects (tracked via brace depth outside strings)
 */
export function sanitizeJsonStrings(jsonText: string): string {
	return walkJsonChars(jsonText, (jsonText, i, inString, result) => {
		if (inString && isStructuralClose(jsonText, i)) {
			// Structural close — end of string value
			result += '"';
			inString = false;
		} else if (inString) {
			// Unescaped content quote (e.g. markdown "text" in commentBody)
			result += '\\"';
		} else {
			// Opening quote — start of string value or key
			result += '"';
			inString = true;
		}
		return { inString, result };
	});
}

/**
 * Conservative variant of `sanitizeJsonStrings` for the retry fallback.
 *
 * Uses the same `isStructuralClose` function as the standard pass but
 * with an additional check for `"` followed by `,` in VALUE context:
 * only closes when the character after `,` starts a new JSON structure
 * (another `"`, `{`, `[`). If the `,` is followed by a letter or digit,
 * the `"` is treated as a content quote.
 *
 * This catches the false-positive pattern where unescaped content quotes
 * inside a JSON string value happen to be followed by `,` or `:`
 * (e.g. `"key",` inside commentBody where `,` is followed by natural
 * language text).
 *
 * Key tracking is done by a separate tokenizer that counts brace depth
 * and distinguishes key context (after `{`/`,` outside string) from value
 * context (after `:` outside string).
 */
export function sanitizeJsonStringsConservative(jsonText: string): string {
	return walkJsonChars(jsonText, (jsonText, i, inString, result) => {
		if (!inString) {
			// Opening quote — start of string value or key
			result += '"';
			inString = true;
		} else if (isStructuralClose(jsonText, i)) {
			// `isStructuralClose` says this is a structural close.
			// But we double-check: if the delimiter after whitespace is
			// `,` or `:`, verify that the next token looks like JSON structure
			// (not a content word).
			const next = nextNonWhitespace(jsonText, i);
			if (next === "," || next === ":") {
				// Skip past the delimiter and any whitespace to check the next token
				const afterPos = skipWhitespace(jsonText, i + 2);
				const afterNext = afterPos < jsonText.length ? jsonText[afterPos] : "";
				// If followed by `"`, `{`, `[`, or end-of-text: this is a genuine
				// structural close (the next JSON value starts).
				// If followed by a letter/digit: the delimiter is content text,
				// so the `"` is a content quote — escape it.
				if (afterNext === '"' || afterNext === "{" || afterNext === "[" || afterNext === "") {
					// Genuine structural close — next token is JSON value
					result += '"';
					inString = false;
				} else {
					// Suspicious — the `,` or `:` might be content text.
					// Escape the quote as content, stay in string.
					result += '\\"';
				}
			} else {
				// For `}` or `]` delimiters: always structural close
				result += '"';
				inString = false;
			}
		} else {
			// Non-structural — content quote
			result += '\\"';
		}
		return { inString, result };
	});
}
