// Domain: the judge's view of the code *around* a test unit.
//
// A verdict depends on what the slice can observe, so the judge also gets the
// file's import/preamble block and the enclosing scope. Both are language-aware
// but shaped the same way, so the prompt stays one reviewable template and the
// slice is never mixed with another test's body.

import { extractImports } from "./inventory-parse.ts";
import type { TestDefinition, TestLanguage } from "./types.ts";

/** Fence label for the prompt's code blocks. */
export function fenceLanguage(language: TestLanguage): string {
	if (language === "go") return "go";
	if (language === "python") return "python";
	if (language === "shell") return "bash";
	if (language === "rust") return "rust";
	return "ts";
}

/** Enclosing scope of a definition, derived from its `a > b > title` name. */
export function scopeHeader(def: { readonly name: string }): string {
	const parts = def.name.split(" > ");
	return parts.length > 1 ? parts.slice(0, -1).join(" > ") : "";
}

/** Preamble line budget: enough to see the imports, small enough to stay cheap. */
const PREAMBLE_LINES = 40;

/** `package` clause plus the import block of a Go file. */
function goPreamble(source: string): string {
	const lines = source.split("\n");
	const kept: string[] = [];
	let inBlock = false;
	for (const [index, line] of lines.entries()) {
		if (index >= PREAMBLE_LINES && !inBlock) break;
		const trimmed = line.trim();
		if (inBlock) {
			kept.push(line);
			if (trimmed.endsWith(")")) inBlock = false;
			continue;
		}
		if (/^package\s/.test(trimmed) || /^import\s/.test(trimmed)) {
			kept.push(line);
			inBlock = trimmed.startsWith("import (") && !trimmed.includes(")");
			continue;
		}
		// A non-import declaration ends the preamble; blank lines and comments
		// between them are dropped.
		if (kept.length > 0 && trimmed !== "" && !trimmed.startsWith("//")) break;
	}
	return kept.join("\n");
}

/** Leading `import`/`from` statements of a Python module. */
function pythonPreamble(source: string): string {
	return source
		.split("\n")
		.slice(0, PREAMBLE_LINES)
		.filter((line) => /^(import|from)\s/.test(line))
		.join("\n");
}

/** The directives at the top of a shell test script. */
function shellPreamble(source: string): string {
	return source
		.split("\n")
		.slice(0, 5)
		.filter((line) => line.startsWith("#!") || /^set\s/.test(line))
		.join("\n");
}

/** The leading `use` statements and crate declarations of a Rust file. */
function rustPreamble(source: string): string {
	return source
		.split("\n")
		.slice(0, PREAMBLE_LINES)
		.filter((line) => /^(pub\s+)?use\s/.test(line) || /^extern crate\s/.test(line))
		.join("\n");
}

/**
 * The file context the judge sees: imports for a node file, the package and
 * import block for Go, the import statements for Python, the directives for a
 * shell script.
 */
export function filePreamble(def: TestDefinition, source: string): string {
	switch (def.language) {
		case "go":
			return goPreamble(source);
		case "python":
			return pythonPreamble(source);
		case "shell":
			return shellPreamble(source);
		case "rust":
			return rustPreamble(source);
		default:
			return extractImports(source, def.file);
	}
}
