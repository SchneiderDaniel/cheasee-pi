// Domain: discovery of Python test functions from source text.
//
// One inventory unit is one `test_*` function or method. Python has no syntax
// tree library in this repository's dependency set, so the scanner is
// indentation-based: a block runs until the next non-blank line whose
// indentation is not deeper than its header, which is exactly how the language
// delimits a block. A `class` block becomes the scope chain of a method, so a
// name reads `TestCart > test_total` like a `describe` chain.
//
// A Python test module with no `def test_*` (the script-style test this repo
// runs with `python3 test/foo.test.py`) yields one whole-file definition rather
// than nothing: the module is runnable, so it must be judged.

import { DiscoveryError, sha256Hex, sliceSource } from "./inventory-parse.ts";
import type { InventoryResult, TestDefinition } from "./types.ts";

const CLASS_HEAD = /^([ \t]*)class[ \t]+([A-Za-z_][A-Za-z0-9_]*)/;
const DEF_HEAD = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_][A-Za-z0-9_]*)/;

interface Frame {
	readonly indent: number;
	readonly kind: "class" | "def";
	/** Scope name (`TestCart > test_total`) for a test definition, else the header name. */
	readonly name: string;
	/** 1-based first line of a test definition, or null for a plain block. */
	readonly startLine: number | null;
	/** 1-based last line seen inside the block. */
	lastBody: number;
}

function indentWidth(text: string): number {
	let width = 0;
	for (const char of text.slice(0, text.length - text.trimStart().length)) {
		width += char === "\t" ? 4 : 1;
	}
	return width;
}

function isBlankOrComment(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "" || trimmed.startsWith("#");
}

/** First line of the decorator run directly above `index`, as a 0-based index. */
function decoratorStart(lines: readonly string[], index: number, indent: number): number {
	let start = index;
	while (start > 0) {
		const previous = lines[start - 1];
		if (!previous.trim().startsWith("@") || indentWidth(previous) !== indent) break;
		start -= 1;
	}
	return start;
}

function definition(
	source: string,
	file: string,
	name: string,
	startLine: number,
	endLine: number,
): TestDefinition {
	return {
		file,
		name,
		language: "python",
		startLine,
		endLine,
		sourceSha256: sha256Hex(sliceSource(source, { startLine, endLine })),
	};
}

/**
 * Discover the `test_*` functions of one Python test module.
 *
 * @param source file contents
 * @param file repository-relative path, echoed verbatim into each definition
 */
export function discoverPythonTests(source: string, file: string): InventoryResult {
	if (!file.endsWith(".py")) {
		throw new DiscoveryError(file, null, "not a Python module (expected *.py)");
	}
	const lines = source.split("\n");
	const frames: Frame[] = [];
	const tests: TestDefinition[] = [];

	const close = (frame: Frame): void => {
		if (frame.startLine === null) return;
		tests.push(definition(source, file, frame.name, frame.startLine, frame.lastBody));
	};

	for (let index = 0; index < lines.length; index += 1) {
		const text = lines[index];
		const lineNumber = index + 1;
		if (isBlankOrComment(text)) continue;
		const indent = indentWidth(text);

		while (frames.length > 0 && frames[frames.length - 1].indent >= indent) {
			const finished = frames.pop();
			if (finished !== undefined) close(finished);
		}
		const parent = frames[frames.length - 1];
		if (parent !== undefined) parent.lastBody = lineNumber;

		const classHead = CLASS_HEAD.exec(text);
		if (classHead !== null) {
			frames.push({
				indent,
				kind: "class",
				name: classHead[2],
				startLine: null,
				lastBody: lineNumber,
			});
			continue;
		}

		const defHead = DEF_HEAD.exec(text);
		if (defHead === null) continue;
		const name = defHead[2];
		const scope = frames.filter((frame) => frame.kind === "class").map((frame) => frame.name);
		frames.push({
			indent,
			kind: "def",
			name: [...scope, name].join(" > "),
			startLine: name.startsWith("test_") ? decoratorStart(lines, index, indent) + 1 : null,
			lastBody: lineNumber,
		});
	}

	while (frames.length > 0) {
		const finished = frames.pop();
		if (finished !== undefined) close(finished);
	}

	return { tests, excluded: [] };
}
