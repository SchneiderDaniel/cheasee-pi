// Domain: brace counting over the structural view of a source file.
//
// The structural view comes from a language scanner where comments and literals
// are already blanked, so a `}` inside a string cannot truncate a slice. Shared
// by the Go and Rust enumerators; the scanners differ, the brace rule does not.
//
// Fail closed: an unterminated body returns null instead of the file length.

/** 1-based line of the brace closing the body that opens at `startLine`, or null. */
export function bodyEndLine(structural: readonly string[], startLine: number): number | null {
	let depth = 0;
	let opened = false;
	let index = startLine - 1;

	while (index < structural.length) {
		for (const char of structural[index]) {
			// Count only structural braces.
			if (char === "{") {
				depth += 1;
				opened = true;
			} else if (char === "}") {
				depth -= 1;
			}
			if (opened && depth === 0) return index + 1;
		}
		index += 1;
	}
	return null;
}
