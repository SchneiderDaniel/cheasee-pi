// Domain: the structural view of a Rust source file.
//
// Rust needs its own scanner because several things a Go scanner would get wrong
// are ordinary here: block comments nest, raw strings carry an arbitrary number
// of `#` delimiters (`r#"…"#`), and `'` is usually a lifetime (`'static`) rather
// than a character literal. Handling all of them keeps a `}` inside a literal
// from truncating a judged range.
//
// This module owns the walk; the per-mode steps live in `inventory-rust-code.ts`
// and `inventory-rust-modes.ts`, the look-ahead predicates in
// `inventory-rust-lex.ts`, and the shared cursor in `inventory-rust-scan.ts`.
// Line numbering stays intact: a line index here is the same line in the source.

import { stepCode } from "./inventory-rust-code.ts";
import { stepBlockComment, stepQuoted, stepRawString } from "./inventory-rust-modes.ts";
import { blank, breakLine, initialState, type ScanState } from "./inventory-rust-scan.ts";

/** `source` with comments and literals replaced by spaces, one entry per line. */
export function rustStructuralLines(source: string): string[] {
	const state = initialState(source);

	while (state.index < state.source.length) {
		if (state.source[state.index] === "\n") {
			resetLine(state);
			continue;
		}
		if (state.mode === "line") {
			blank(state, 1);
			state.index += 1;
			continue;
		}
		if (state.mode === "block") {
			stepBlockComment(state);
			continue;
		}
		if (state.mode === "raw") {
			stepRawString(state);
			continue;
		}
		if (state.mode === "string" || state.mode === "char") {
			stepQuoted(state);
			continue;
		}
		stepCode(state);
	}

	state.lines.push(state.line);
	return state.lines;
}

/**
 * Close the line under construction. A raw string or a block comment
 * legitimately spans lines; a single-line comment or literal ends with its line.
 */
function resetLine(state: ScanState): void {
	if (state.mode === "line" || state.mode === "string" || state.mode === "char") {
		state.mode = "code";
	}
	breakLine(state);
	state.index += 1;
}
