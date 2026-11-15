// Domain: the mutable state the Rust structural scanner carries between steps.
//
// The scanner walks the source once, one character at a time. Splitting the walk
// across siblings needs one shared state object, so the mode, the cursor, and the
// output line live here rather than in any single step handler.

/** Where in the source the scanner believes it is. */
type Mode = "code" | "line" | "block" | "string" | "char" | "raw";

/** Cursor, mode, and the line being built. */
export interface ScanState {
	readonly source: string;
	/** Completed lines, in source order; one entry per source line. */
	readonly lines: string[];
	/** The line under construction, literals blanked out. */
	line: string;
	/** Index of the next character to consume. */
	index: number;
	mode: Mode;
	/** Nesting depth of the block comment being scanned. */
	blockDepth: number;
	/** `#` count of the raw string being scanned. */
	rawHashes: number;
}

/** Write `count` spaces over the text at the cursor (a blanked literal). */
export function blank(state: ScanState, count: number): void {
	state.line += " ".repeat(count);
}

/** Close the line under construction and start an empty one. */
export function breakLine(state: ScanState): void {
	state.lines.push(state.line);
	state.line = "";
}

/** A fresh state for one source text. */
export function initialState(source: string): ScanState {
	return {
		source,
		lines: [],
		line: "",
		index: 0,
		mode: "code",
		blockDepth: 0,
		rawHashes: 0,
	};
}
