// ─── JSON string/escape state machine ───────────────────────────
// Sole owner of the JSON escape rule in the scanner: string/escape tracking
// and the character walk. Whitespace skipping and the structural-close
// heuristic live in json-whitespace.ts. Split out of last-json-scanner.ts
// (issue #2033); re-exported from there.

// ─── String/Escape Tracking ───────────────────────────────────────

/**
 * Outcome of one character for the string/escape tracker.
 * - `escaped`: the character was consumed by a preceding backslash
 * - `escapeStart`: a backslash inside a string starts an escape
 * - `quote`: an unescaped `"` toggled string state (quote *policy* is the
 *   caller's: extraction ignores it, sanitizers route it through
 *   `isStructuralClose`)
 * - `plain`: ordinary character
 */
export type StringStepRole = "escaped" | "escapeStart" | "quote" | "plain";

/**
 * Advance the string/escape tracker by one character. Sole owner of the
 * JSON escape rule in this module — the fence scan, the brace scan, and
 * `walkJsonChars` all delegate here.
 *
 * Simple toggle — content quotes inside string values almost always come
 * in pairs, so the net effect on string boundary tracking is correct.
 * Using simple toggle avoids a false-positive structural close when a
 * content quote is followed by `,`, `}`, `]`, or `:`.
 */
export function stepStringState(
	ch: string | undefined,
	state: { inString: boolean; escaped: boolean },
): { state: { inString: boolean; escaped: boolean }; role: StringStepRole } {
	if (ch === undefined) return { state, role: "plain" };
	if (state.escaped)
		return { state: { inString: state.inString, escaped: false }, role: "escaped" };
	if (state.inString && ch === "\\") {
		return { state: { inString: state.inString, escaped: true }, role: "escapeStart" };
	}
	if (ch === '"') return { state: { inString: !state.inString, escaped: false }, role: "quote" };
	return { state, role: "plain" };
}

// ─── JSON Walking ─────────────────────────────────────────────────

/**
 * Callback invoked for each `"` character during JSON string walking.
 * Receives the current state and returns the updated state after handling.
 */
export type QuoteHandler = (
	jsonText: string,
	i: number,
	inString: boolean,
	result: string,
) => { inString: boolean; result: string };

/**
 * Walk JSON text character by character, tracking escape state and
 * string boundaries via `stepStringState`. Delegates `"` handling to the
 * provided callback. Literal newline replacement inside strings lives
 * here — both sanitizer variants call this.
 */
export function walkJsonChars(jsonText: string, onQuote: QuoteHandler): string {
	let result = "";
	let stringState = { inString: false, escaped: false };

	for (let i = 0; i < jsonText.length; i++) {
		const ch = jsonText[i];
		const inStringBefore = stringState.inString;
		const step = stepStringState(ch, stringState);
		const role = step.role;
		stringState = step.state;

		if (role === "escaped" || role === "escapeStart") {
			result += ch;
			continue;
		}

		if (role === "quote") {
			const next = onQuote(jsonText, i, inStringBefore, result);
			result = next.result;
			stringState = { inString: next.inString, escaped: false };
			continue;
		}

		if (stringState.inString && (ch === "\n" || ch === "\r")) {
			result += ch === "\n" ? "\\n" : "\\r";
			continue;
		}

		result += ch;
	}

	return result;
}
