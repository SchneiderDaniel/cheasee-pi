// Domain: discovery of Go test entry points from source text.
//
// One unit is one runnable entry point in a `_test.go` file. `go test` runs
// `func TestXxx`, `func FuzzXxx`, `func ExampleXxx`; benchmarks need `-bench`,
// so they land in `excluded`. A `_test.go` file with no entry point is a
// support file and is excluded by name, never dropped silently.
//
// The literal-aware line scanner lives in `inventory-go-literals.ts` and the
// brace matcher in `inventory-go-braces.ts`; this module owns the Go naming rules
// and the definition ranges.

import { bodyEndLine } from "./inventory-go-braces.ts";
import { structuralLines } from "./inventory-go-literals.ts";
import { DiscoveryError, sha256Hex, sliceSource } from "./inventory-parse.ts";
import type { ExcludedDefinition, InventoryResult, TestDefinition } from "./types.ts";

const RUNNABLE_PREFIXES = ["Test", "Fuzz", "Example"] as const;
const BENCHMARK_PREFIX = "Benchmark";
const FUNC_HEAD = /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*[([{]/;

/** `go test` skips a suffix that starts lowercase: `Testhelper` is not a test. */
function suffixIsRunnable(name: string, prefix: string): boolean {
	if (!name.startsWith(prefix)) return false;
	const rest = name.slice(prefix.length);
	return rest === "" || !/^[a-z]/.test(rest);
}

/** True when `go test` runs a function with this name. */
function isRunnableGoTestName(name: string): boolean {
	return RUNNABLE_PREFIXES.some((prefix) => suffixIsRunnable(name, prefix));
}

function isBenchmarkName(name: string): boolean {
	return suffixIsRunnable(name, BENCHMARK_PREFIX);
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
		language: "go",
		startLine,
		endLine,
		sourceSha256: sha256Hex(sliceSource(source, { startLine, endLine })),
	};
}

function lastContentLine(lines: readonly string[]): number {
	let index = lines.length - 1;
	while (index > 0 && lines[index].trim() === "") index -= 1;
	return index + 1;
}

/**
 * Discover the Go test entry points of one `_test.go` file.
 *
 * @throws DiscoveryError when the file is not a Go test file, or a body is unterminated
 */
export function discoverGoTests(source: string, file: string): InventoryResult {
	if (!file.endsWith("_test.go")) {
		throw new DiscoveryError(file, null, "not a Go test file (expected *_test.go)");
	}
	const lines = source.split("\n");
	const structural = structuralLines(source);
	const tests: TestDefinition[] = [];
	const excluded: ExcludedDefinition[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const head = FUNC_HEAD.exec(lines[index]);
		if (head === null) continue;
		const name = head[1];
		const startLine = index + 1;
		const endLine = bodyEndLine(structural, startLine);
		if (endLine === null) {
			throw new DiscoveryError(file, startLine, `unterminated function body: func ${name}`);
		}
		const def = definition(source, file, name, startLine, endLine);
		if (isRunnableGoTestName(name)) tests.push(def);
		else if (isBenchmarkName(name)) excluded.push({ ...def, reason: "not-run-by-default" });
	}

	if (tests.length === 0 && excluded.length === 0) {
		const endLine = lastContentLine(lines);
		const name = file.split("/").at(-1) ?? file;
		excluded.push({
			...definition(source, file, name, 1, endLine),
			reason: "test-support-file",
		});
	}

	return { tests, excluded };
}
