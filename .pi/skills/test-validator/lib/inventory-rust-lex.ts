// Domain: the three look-ahead decisions a Rust line scanner cannot avoid.
//
// Each one exists because a character that usually opens a literal sometimes
// does not: `r` may end an identifier instead of starting a raw string, and `'`
// is far more often a lifetime than a character literal.

function isIdentifierChar(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/**
 * A raw string starting at `index` (`r"…"`, `r#"…"#`, `br##"…"##`), or null.
 * The `#` count is the close delimiter the scanner has to wait for.
 */
export function rawStart(source: string, index: number): { hashes: number; length: number } | null {
	const byte = source[index] === "b" && source[index + 1] === "r";
	const prefix = byte ? 2 : source[index] === "r" ? 1 : 0;
	if (prefix === 0) return null;
	// `for` / `err` / `arbitrary` end in `r`; only a bare prefix starts a literal.
	if (isIdentifierChar(source[index - 1])) return null;
	let cursor = index + prefix;
	let hashes = 0;
	while (source[cursor] === "#") {
		hashes += 1;
		cursor += 1;
	}
	if (source[cursor] !== '"') return null;
	return { hashes, length: cursor - index + 1 };
}

/**
 * A `'` opens a character literal only when a closing quote follows; otherwise
 * it is a lifetime, which is code.
 */
export function startsCharLiteral(source: string, index: number): boolean {
	const next = source[index + 1];
	if (next === "\\") return true;
	return next !== undefined && next !== "\n" && source[index + 2] === "'";
}
