// ─── Last-JSON Scanner ───────────────────────────────────────────
// Extract the agent's FINAL JSON object from noisy output. Steps: strip the
// 💭 thinking prefix, prefer the last markdown code fence, then string-
// boundary-aware brace counting. Split by responsibility (issue #2033): the
// escape rule and character walk in json-string-state.ts, the sanitizers in
// json-sanitize.ts, the fence scan in json-fence.ts, line filtering in
// json-metadata.ts. Names are re-exported here so callers are untouched.

import { stepStringState } from "./json-string-state.ts";
import { extractFenceContents } from "./json-fence.ts";
import { stripMetadataLines } from "./json-metadata.ts";

export { sanitizeJsonStrings, sanitizeJsonStringsConservative } from "./json-sanitize.ts";

/** 💭 prefix on every line of an agent thinking block. */
const THINKING_PREFIX_RE = /^💭\s*/gm;

/**
 * The last complete outermost `{...}` span, string-boundary aware, or null.
 * Returns the LAST pair because the agent's JSON is its final output.
 */
function lastBraceSpan(text: string): { start: number; end: number } | null {
	let depth = 0;
	let lastStart = -1;
	let lastEnd = -1;
	let stringState = { inString: false, escaped: false };
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const step = stepStringState(ch, stringState);
		stringState = step.state;
		if (step.role !== "plain" || stringState.inString) continue;
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
	return lastEnd >= 0 && lastStart >= 0 ? { start: lastStart, end: lastEnd } : null;
}

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
export function extractLastJson(raw: string, toolNames?: Set<string>): string {
	// Step 1: Strip 💭 prefix for code fence detection.
	// Agents with thinking:high emit JSON in thinking blocks, which
	// get pushed to fullLog with "💭 " per line. Stripping recovers
	// valid JSON content between fences.
	const fenceSearchText = raw.replace(THINKING_PREFIX_RE, "");

	// Step 2: Prefer the LAST code fence (JSON is final output).
	const fenceContents = extractFenceContents(fenceSearchText);
	if (fenceContents.length > 0) {
		return fenceContents[fenceContents.length - 1]!;
	}

	// Step 3: No code fences — drop metadata/tool lines, then brace count.
	const braceCandidate = stripMetadataLines(fenceSearchText, toolNames);
	const span = lastBraceSpan(braceCandidate);
	if (!span) return ""; // No valid JSON structure found — return empty instead of raw text
	return braceCandidate.slice(span.start, span.end + 1);
}

export { THINKING_PREFIX_RE };
