// Domain: code mode of the Rust structural scanner — the decisions made between
// literals and comments. Each branch consumes the terminator it opened plus the
// characters that identify it, and blanks them so line numbering never shifts.

import { rawStart, startsCharLiteral } from "./inventory-rust-lex.ts";
import { blank, type ScanState } from "./inventory-rust-scan.ts";

/** Open a comment or literal, or copy one code character through. */
export function stepCode(state: ScanState): void {
	const char = state.source[state.index];
	const next = state.source[state.index + 1];

	if (char === "/" && next === "/") {
		state.mode = "line";
		blank(state, 2);
		state.index += 2;
		return;
	}
	if (char === "/" && next === "*") {
		state.mode = "block";
		state.blockDepth = 1;
		blank(state, 2);
		state.index += 2;
		return;
	}
	if (char === '"') {
		state.mode = "string";
		blank(state, 1);
		state.index += 1;
		return;
	}
	if (char === "'" && startsCharLiteral(state.source, state.index)) {
		state.mode = "char";
		blank(state, 1);
		state.index += 1;
		return;
	}

	const raw = rawStart(state.source, state.index);
	if (raw !== null) {
		state.mode = "raw";
		state.rawHashes = raw.hashes;
		blank(state, raw.length);
		state.index += raw.length;
		return;
	}

	state.line += char;
	state.index += 1;
}
