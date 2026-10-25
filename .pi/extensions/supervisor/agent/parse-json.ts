// ─── JSON recovery ──────────────────────────────────────────────
// JSON.parse with the two strategies agents actually need: a conservative
// re-sanitize for unescaped quotes inside string values, and trailing-content
// auto-recovery when the model appends prose after the object.

import { sanitizeJsonStringsConservative } from "./last-json-scanner.ts";

export type JsonParseOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse sanitized agent JSON, retrying both recovery strategies. */
export function parseWithRecovery(jsonStr: string, sanitized: string): JsonParseOutcome {
	let parsed: unknown;
	try {
		parsed = JSON.parse(sanitized);
	} catch (e: unknown) {
		// Retry with conservative strategy — treats `"` followed by `,` or `:`
		// as content quotes (not structural close) to handle the false-positive
		// pattern where unescaped quotes inside string values are followed by
		// delimiters (e.g. `"key",` or `"value":` inside commentBody).
		try {
			parsed = JSON.parse(sanitizeJsonStringsConservative(jsonStr));
		} catch {
			// Both passes failed — fall through to auto-recovery
		}

		if (!parsed) {
			const msg = e instanceof Error ? e.message : String(e);

			// Auto-recovery: trailing non-JSON content (e.g. agent appends text after JSON)
			// Error like "Unexpected non-whitespace character after JSON at position 3137"
			const posMatch = msg.match(/position (\d+)/);
			if (posMatch) {
				const pos = parseInt(posMatch[1], 10);
				if (pos > 10 && pos < sanitized.length) {
					try {
						parsed = JSON.parse(sanitized.slice(0, pos));
					} catch {
						// retry failed — fall through to error return
					}
				}
			}
		}

		if (!parsed) {
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, error: msg };
		}
	}
	return { ok: true, value: parsed };
}
