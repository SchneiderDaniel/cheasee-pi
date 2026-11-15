// Domain: pick the discovery strategy for one test file.
//
// The repository audit must cover every runnable test file, not only the ones
// written against `node:test`, so this module owns the per-language dispatch and
// one shared rule: a runnable test file that yields no statically enumerable
// unit becomes ONE whole-file definition. That rule is what keeps the
// completion gate honest — a file can never vanish from the inventory because
// its runner uses a shape the scanner does not model.

import { DiscoveryError, sha256Hex, sliceSource } from "./inventory-parse.ts";
import { discoverGoTests } from "./inventory-go.ts";
import { discoverPythonTests } from "./inventory-python.ts";
import { discoverRustTests } from "./inventory-rust.ts";
import { discoverTests } from "./inventory.ts";
import type { InventoryResult, TestDefinition, TestLanguage } from "./types.ts";

const NODE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];

/** The language of a test file, or null when the audit cannot enumerate it. */
export function languageOf(file: string): TestLanguage | null {
	if (file.endsWith("_test.go")) return "go";
	if (file.endsWith(".py")) return "python";
	if (file.endsWith(".sh") || file.endsWith(".bash")) return "shell";
	if (file.endsWith(".rs")) return "rust";
	if (NODE_EXTENSIONS.some((extension) => file.endsWith(extension))) return "typescript";
	return null;
}

/** 1-based last line that carries any content. */
function lastContentLine(source: string): number {
	const lines = source.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index].trim() !== "") return index + 1;
	}
	return 1;
}

/** The whole file as one definition, named after the file itself. */
function wholeFileDefinition(source: string, file: string, language: TestLanguage): TestDefinition {
	const startLine = 1;
	const endLine = lastContentLine(source);
	return {
		file,
		name: file.split("/").at(-1) ?? file,
		language,
		startLine,
		endLine,
		sourceSha256: sha256Hex(sliceSource(source, { startLine, endLine })),
	};
}

/**
 * Discover every runnable test unit in one file.
 *
 * @param source file contents
 * @param file repository-relative path, used verbatim in names and errors
 * @throws DiscoveryError when the file kind cannot be enumerated or is unparsable
 */
export function discoverInFile(source: string, file: string): InventoryResult {
	const language = languageOf(file);
	if (language === null) {
		throw new DiscoveryError(
			file,
			null,
			"cannot enumerate tests: unsupported test file kind (supported: node, Go *_test.go, Python, shell, Rust)",
		);
	}

	if (language === "go") return discoverGoTests(source, file);
	// Rust has no test-file naming convention: the scanner decides both the file
	// set and the units, and a source file with no test attribute yields nothing.
	if (language === "rust") return discoverRustTests(source, file);
	if (language === "python") {
		const result = discoverPythonTests(source, file);
		return result.tests.length === 0
			? { tests: [wholeFileDefinition(source, file, "python")], excluded: result.excluded }
			: result;
	}

	if (language === "shell")
		return { tests: [wholeFileDefinition(source, file, "shell")], excluded: [] };

	const result = discoverTests(source, file);
	if (result.tests.length > 0 || result.excluded.length > 0) return result;
	// A node test file whose runner is not `node:test`: the file is the unit.
	return { tests: [wholeFileDefinition(source, file, "typescript")], excluded: [] };
}
