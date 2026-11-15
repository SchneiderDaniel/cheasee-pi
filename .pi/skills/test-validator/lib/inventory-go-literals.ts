// Domain: the structural view of a Go source file.
//
// `structuralLines` blanks comments, string literals, raw strings, runes. Line
// numbering stays intact, so a line index here is the same line in the source.

type ScanMode = "code" | "line" | "block" | "string" | "raw" | "rune";

/** `source` with comments and literals replaced by spaces, one entry per line. */
export function structuralLines(source: string): string[] {
	const lines: string[] = [];
	let line = "";
	let mode: ScanMode = "code";
	let index = 0;

	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];

		if (char === "\n") {
			if (mode === "line" || mode === "string" || mode === "rune") mode = "code";
			lines.push(line);
			line = "";
			index += 1;
			continue;
		}

		if (mode === "code") {
			if (char === "/" && next === "/") {
				mode = "line";
				line += "  ";
				index += 2;
				continue;
			}
			if (char === "/" && next === "*") {
				mode = "block";
				line += "  ";
				index += 2;
				continue;
			}
			if (char === '"') mode = "string";
			if (char === "`") mode = "raw";
			if (char === "'") mode = "rune";
			line += char;
			index += 1;
			continue;
		}

		if (mode === "block" && char === "*" && next === "/") {
			mode = "code";
			line += "  ";
			index += 2;
			continue;
		}
		if (mode !== "raw" && char === "\\") {
			line += "  ";
			index += 2;
			continue;
		}
		if (mode === "string" && char === '"') mode = "code";
		if (mode === "raw" && char === "`") mode = "code";
		if (mode === "rune" && char === "'") mode = "code";
		line += " ";
		index += 1;
	}

	lines.push(line);
	return lines;
}
