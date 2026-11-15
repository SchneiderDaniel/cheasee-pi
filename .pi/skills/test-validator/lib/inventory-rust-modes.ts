// Domain: one step of the Rust structural scanner, per multi-character mode.
//
// Each handler consumes as much of the source as its mode needs and leaves the
// cursor on the next unconsumed character. Blanking keeps every line index the
// same as the source line, so a judged range never shifts.
//
// Three modes live here: a nested block comment, a raw string whose `#` run sets
// its close delimiter, and a quoted string or character literal with escapes.

import { blank, breakLine, type ScanState } from "./inventory-rust-scan.ts";

/** Inside a block comment, where nesting is legal and only the outer close returns. */
export function stepBlockComment(state: ScanState): void {
	const char = state.source[state.index];
	const next = state.source[state.index + 1];
	if (char === "/" && next === "*") {
		state.blockDepth += 1;
		blank(state, 2);
		state.index += 2;
		return;
	}
	if (char === "*" && next === "/") {
		state.blockDepth -= 1;
		blank(state, 2);
		state.index += 2;
		// Only the outermost close returns to code; an inner one stays in the comment.
		if (state.blockDepth === 0) state.mode = "code";
		return;
	}
	blank(state, 1);
	state.index += 1;
}

/** Inside `r#"…"#`: the closing quote only counts once its `#` run matches. */
export function stepRawString(state: ScanState): void {
	const char = state.source[state.index];
	if (char === '"') {
		let cursor = state.index + 1;
		let hashes = 0;
		while (hashes < state.rawHashes && state.source[cursor] === "#") {
			cursor += 1;
			hashes += 1;
		}
		if (hashes === state.rawHashes) {
			state.mode = "code";
			blank(state, cursor - state.index);
			state.index = cursor;
			return;
		}
	}
	blank(state, 1);
	state.index += 1;
}

/** Inside `"…"` or `'…'`, where a backslash escapes the next character. */
export function stepQuoted(state: ScanState): void {
	const char = state.source[state.index];
	const next = state.source[state.index + 1];
	if (char === "\\") {
		// A trailing backslash continues the literal on the next line, so the
		// newline is consumed here and the literal stays open.
		if (next === "\n") {
			breakLine(state);
			state.index += 2;
			return;
		}
		blank(state, 2);
		state.index += 2;
		return;
	}
	if (state.mode === "string" && char === '"') state.mode = "code";
	if (state.mode === "char" && char === "'") state.mode = "code";
	blank(state, 1);
	state.index += 1;
}
