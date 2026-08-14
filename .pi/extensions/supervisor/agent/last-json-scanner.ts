// ─── Last-JSON Scanner ───────────────────────────────────────────
// Extracts the last JSON object from raw agent text, with two-pass
// sanitization (standard + conservative retry) as the safety net for
// truncated/malformed agent output. Leaf module — must never import
// from output.ts (ESM cycle risk); output.ts imports from here.

import { isToolLine } from "../lib/tool-line.ts";

// ─── Thinking Prefix Stripping ──────────────────────────────────────

/**
 * Strip "💭 " prefix from lines in text.
 *
 * When agents use `thinking: high`, the JSON output may be emitted inside
 * thinking blocks instead of text blocks. The event handlers push thinking
 * content to fullLog with the "💭 " prefix on each line. This prefix makes
 * the text invalid JSON, causing parseAgentOutput to fail.
 *
 * Stripping "💭 " from the start of each line recovers the original JSON
 * so it can be extracted and parsed correctly.
 */
const THINKING_PREFIX_RE = /^💭\s*/gm;

// ─── Smart Quote Detection ──────────────────────────────────────

/**
 * Skip whitespace characters (space, tab, newline, carriage return)
 * starting from index `i`. When `reverse` is true, scans backward.
 * Returns the index of the first non-whitespace character, or
 * `text.length` (forward) / `-1` (reverse) if all whitespace.
 */
function skipWhitespace(text: string, i: number, reverse?: boolean): number {
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
function isStructuralClose(text: string, i: number): boolean {
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

// ─── JSON Sanitization ────────────────────────────────────────────

/**
 * Callback invoked for each `"` character during JSON string walking.
 * Receives the current state and returns the updated state after handling.
 */
type QuoteHandler = (
	jsonText: string,
	i: number,
	inString: boolean,
	result: string,
) => { inString: boolean; result: string };

/**
 * Walk JSON text character by character, tracking escape state and
 * string boundaries. Delegates `"` handling to the provided callback.
 * The shared escape preamble (backslash tracking, literal newline
 * replacement) lives here — both sanitizer variants call this.
 */
function walkJsonChars(jsonText: string, onQuote: QuoteHandler): string {
	let result = "";
	let inString = false;
	let escaped = false;

	for (let i = 0; i < jsonText.length; i++) {
		const ch = jsonText[i];
		if (escaped) {
			result += ch;
			escaped = false;
			continue;
		}

		if (inString && ch === "\\") {
			result += ch;
			escaped = true;
			continue;
		}

		if (ch === '"') {
			const next = onQuote(jsonText, i, inString, result);
			result = next.result;
			inString = next.inString;
			continue;
		}

		if (inString && (ch === "\n" || ch === "\r")) {
			result += ch === "\n" ? "\\n" : "\\r";
			continue;
		}

		result += ch;
	}

	return result;
}

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
function sanitizeJsonStrings(jsonText: string): string {
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

// ─── Conservative Fallback ────────────────────────────────────────

/**
 * Get the next non-whitespace character after position `i` in `text`.
 * Returns empty string if at end of text.
 */
function nextNonWhitespace(text: string, i: number): string {
	return text[skipWhitespace(text, i + 1)] ?? "";
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
function sanitizeJsonStringsConservative(jsonText: string): string {
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

// ─── JSON Extraction ──────────────────────────────────────────────

/**
 * Extract the last JSON object from a string.
 * Handles:
 * - Pure JSON input
 * - JSON embedded in markdown code fences (```json ... ```)
 * - JSON with surrounding text
 * - Multiple JSON objects (picks last)
 *
 * Brace matching uses simple quote toggle (every " toggles inString) to
 * be string-boundary aware — { and } inside JSON string values (e.g.,
 * tool args like {"pattern":"function.*{"}) are ignored. Simple toggle
 * works because unescaped content quotes almost always come in pairs,
 * so the net effect on string tracking is correct.
 *
 * Note: The sanitizer (sanitizeJsonStrings) uses the smarter
 * isStructuralClose heuristic with a conservative retry fallback for
 * identifying content quotes that need escaping. The extraction step
 * doesn't need that precision — it only needs to skip { } inside strings.
 */
function extractLastJson(raw: string, toolNames?: Set<string>): string {
	// Step 1: Strip 💭 prefix for code fence detection.
	// Agents with thinking:high emit JSON in thinking blocks, which
	// get pushed to fullLog with "💭 " per line. Stripping recovers
	// valid JSON content between fences.
	const fenceSearchText = raw.replace(THINKING_PREFIX_RE, "");

	// Step 2: Find all markdown code fence regions (```json or ```).
	// Unlike the old regex approach, we scan character-by-character
	// to find matching fence pairs. This correctly handles triple
	// backticks inside JSON string values (e.g. markdown code blocks
	// in commentBody) — they are inside a string and don't close the
	// outer fence. We track string boundaries to skip ``` inside strings.
	const fenceContents: string[] = [];
	let pos = 0;
	while (pos < fenceSearchText.length) {
		// Find opening ``` (optionally followed by "json")
		const fenceStart = fenceSearchText.indexOf("```", pos);
		if (fenceStart === -1) break;

		// Skip past optional language tag and newline
		let afterOpen = fenceStart + 3;
		if (fenceSearchText.startsWith("json", afterOpen)) {
			afterOpen += 4;
		}
		// Skip whitespace/newline after opening fence
		while (
			afterOpen < fenceSearchText.length &&
			(fenceSearchText[afterOpen] === " " ||
				fenceSearchText[afterOpen] === "\t" ||
				fenceSearchText[afterOpen] === "\n" ||
				fenceSearchText[afterOpen] === "\r")
		) {
			afterOpen++;
		}

		// Scan for closing ``` — string-boundary aware
		// We look for ``` that is NOT inside a JSON string value.
		let inString = false;
		let escaped = false;
		let fenceEnd = -1;
		for (let i = afterOpen; i < fenceSearchText.length; i++) {
			const ch = fenceSearchText[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (inString && ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				// Simple toggle — content quotes inside string values
				// almost always come in pairs, so the net effect on
				// string boundary tracking is correct. Using simple
				// toggle avoids false-positive structural close when
				// a content quote is followed by `,`, `}`, `]`, or `:`.
				inString = !inString;
				continue;
			}
			if (!inString && ch === "`" && fenceSearchText.startsWith("```", i)) {
				fenceEnd = i;
				break;
			}
		}

		if (fenceEnd !== -1) {
			fenceContents.push(fenceSearchText.slice(afterOpen, fenceEnd).trim());
			pos = fenceEnd + 3;
		} else {
			// Unclosed fence — skip past the opening
			pos = afterOpen;
		}
	}

	// If we found fence content, use the LAST one (JSON is final output)
	if (fenceContents.length > 0) {
		return fenceContents[fenceContents.length - 1];
	}

	// Step 2: No code fences — filter metadata lines then simple brace counting.
	// Lines starting with 🔧, ✓, ✗, 📋, 📊 are tool execution/debug markers pushed
	// to fullLog by event handlers. Their content may contain `{`, `}` from tool
	// args/results, which would corrupt simple brace counting.
	// These lines are never part of the agent's structured JSON output.
	//
	// Use fenceSearchText (💭 prefix already stripped) so JSON inside thinking
	// blocks is valid. Use SIMPLE brace counting (no string tracking) so
	// double-quotes in thinking content do NOT corrupt brace matching.
	const metadataLineRe = /^[\u{1F527}\u{2713}\u{2717}\u{1F4CB}\u{1F4CA}]/u;
	let braceCandidateRaw = fenceSearchText;
	// Check if any filtering is needed (either old-format metadata lines or new-format tool call lines)
	const needsMetadataFilter = metadataLineRe.test(fenceSearchText);
	const needsToolCallFilter = fenceSearchText.split("\n").some((l) => isToolLine(l, toolNames));
	if (needsMetadataFilter || needsToolCallFilter) {
		const lines = fenceSearchText.split("\n");
		const filteredLines: string[] = [];
		for (const line of lines) {
			const trimmed = line.trimStart();
			if (!metadataLineRe.test(trimmed) && !isToolLine(trimmed, toolNames)) {
				filteredLines.push(line);
			}
		}
		if (filteredLines.length > 0 && filteredLines.length < lines.length) {
			braceCandidateRaw = filteredLines.join("\n");
		}
	}

	// Step 3: String-boundary-aware brace counting — find all complete outermost {} pairs.
	// Uses the same inString/escaped tracking as Step 2's fence scanner and
	// sanitizeJsonStrings to ignore { and } inside JSON string values.
	// Metadata tool lines (🔧 ✓ ✗ 📋 📊) with {}/quotes are already filtered.
	// Returns the LAST complete outermost pair (agent's JSON is final output).
	let depth = 0;
	let lastStart = -1;
	let lastEnd = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < braceCandidateRaw.length; i++) {
		const ch = braceCandidateRaw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString && ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			// Simple toggle — content quotes inside string values
			// almost always come in pairs, so the net effect on
			// string boundary tracking is correct. Using simple
			// toggle avoids false-positive structural close when
			// a content quote is followed by `,`, `}`, `]`, or `:`.
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") {
			if (depth === 0) lastStart = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && lastStart >= 0) {
				lastEnd = i;
			}
		}
	}

	if (lastEnd >= 0 && lastStart >= 0) {
		return braceCandidateRaw.slice(lastStart, lastEnd + 1);
	}

	// No valid JSON structure found — return empty instead of raw text
	return "";
}

export {
	extractLastJson,
	sanitizeJsonStrings,
	sanitizeJsonStringsConservative,
	THINKING_PREFIX_RE,
};
