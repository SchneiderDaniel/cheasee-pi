// Domain: discovery of Rust test functions from source text.
//
// `cargo test` runs every function carrying a test attribute: `#[test]`,
// `#[tokio::test]`, `#[actix_web::test]`, and any other path whose last segment
// is `test`. This repository runs exactly such a suite — the UI crate's Docker
// build executes `cargo test`, and the PR smoke gate builds that image — so those
// functions are missing from any audit that skips Rust.
//
// Rust has no test-file naming convention, so the file set is decided by content:
// a `.rs` file that declares no test function is a source file, not a test file,
// and contributes nothing. An `#[ignore]` test is excluded as not run by default.
//
// Attribute attachment lives in `inventory-rust-attributes.ts` and the module
// chain in `inventory-rust-modules.ts`; this module owns the unit identity only.
//
// Fail closed: an unterminated body, or a test attribute the scanner cannot
// attribute to a function, throws `DiscoveryError` instead of dropping a runnable
// test from the inventory.

import {
	attributeIndex,
	attributesAttachedTo,
	attributesOf,
	isIgnoreAttribute,
	isTestAttribute,
	lastSegment,
} from "./inventory-rust-attributes.ts";
import { bodyEndLine } from "./inventory-braces.ts";
import { moduleChain, moduleScopes } from "./inventory-rust-modules.ts";
import { DiscoveryError, sha256Hex, sliceSource } from "./inventory-parse.ts";
import { rustStructuralLines } from "./inventory-rust-literals.ts";
import type { ExcludedDefinition, InventoryResult, TestDefinition } from "./types.ts";

const FN_HEAD = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/;

/**
 * Test macros this scanner does not model. Encountering one halts the run: a
 * silently un-enumerated test would make the completion claim false.
 */
const UNMODELLED_TEST_MACROS = new Set(["rstest", "test_case", "test_case_name"]);

function rustDefinition(
	source: string,
	file: string,
	name: string,
	startLine: number,
	endLine: number,
): TestDefinition {
	return {
		file,
		name,
		language: "rust",
		startLine,
		endLine,
		sourceSha256: sha256Hex(sliceSource(source, { startLine, endLine })),
	};
}

/** True when a Rust file declares at least one test function. */
export function declaresRustTest(source: string): boolean {
	const structural = rustStructuralLines(source);
	return structural.some((line) => attributesOf(line).some((path) => isTestAttribute(path)));
}

/** Every test attribute the run must see accounted for, as `[line, path]`. */
function unclaimedTestAttributes(
	attributeLines: Map<number, string[]>,
	claimed: ReadonlySet<number>,
	file: string,
): void {
	for (const [line, paths] of attributeLines) {
		for (const path of paths) {
			const macro = lastSegment(path);
			if (UNMODELLED_TEST_MACROS.has(macro)) {
				throw new DiscoveryError(
					file,
					line,
					`unsupported Rust test attribute #[${path}]; add it to inventory-rust.ts`,
				);
			}
			if (!isTestAttribute(path) || claimed.has(line)) continue;
			throw new DiscoveryError(
				file,
				line,
				`test attribute #[${path}] is not attached to a function this scanner can judge`,
			);
		}
	}
}

/**
 * Discover the test functions of one Rust source file.
 *
 * @param source file contents
 * @param file repository-relative path, echoed verbatim into each definition
 * @throws DiscoveryError when the file is not Rust, a body is unterminated, or a
 *   test attribute cannot be attributed to a function
 */
export function discoverRustTests(source: string, file: string): InventoryResult {
	if (!file.endsWith(".rs")) {
		throw new DiscoveryError(file, null, "not a Rust source file (expected *.rs)");
	}
	const structural = rustStructuralLines(source);
	const scopeList = moduleScopes(structural, file);
	const attributeLines = attributeIndex(structural);

	const tests: TestDefinition[] = [];
	const excluded: ExcludedDefinition[] = [];
	const claimed = new Set<number>();

	for (let index = 0; index < structural.length; index += 1) {
		const head = FN_HEAD.exec(structural[index]);
		if (head === null) continue;
		const attached = attributesAttachedTo(structural, index, attributeLines);
		if (!attached.some((attribute) => isTestAttribute(attribute.path))) continue;

		const fnLine = index + 1;
		const endLine = bodyEndLine(structural, fnLine);
		if (endLine === null) {
			throw new DiscoveryError(file, fnLine, `unterminated function body: fn ${head[1]}`);
		}
		const startLine = Math.min(...attached.map((attribute) => attribute.line));
		for (const attribute of attached) claimed.add(attribute.line);
		const name = [...moduleChain(scopeList, fnLine), head[1]].join(" > ");
		const def = rustDefinition(source, file, name, startLine, endLine);
		if (attached.some((attribute) => isIgnoreAttribute(attribute.path))) {
			excluded.push({ ...def, reason: "not-run-by-default" });
		} else {
			tests.push(def);
		}
	}

	unclaimedTestAttributes(attributeLines, claimed, file);
	return { tests, excluded };
}
