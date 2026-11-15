// Phase 1e — Rust discovery. `cargo test` (run by the UI crate's Docker build,
// which the PR smoke gate builds) executes every `#[test]`-attributed function,
// so those functions are inventory entries like any other. Discovery is
// content-based because Rust has no test-file naming convention: a `.rs` file
// counts only when it declares a test function, and a source file with none is
// not a test file at all.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { discoverInFile, languageOf } from "../lib/inventory-file.ts";
import { DiscoveryError, sha256Hex, sliceSource } from "../lib/inventory-parse.ts";
import { declaresRustTest, discoverRustTests } from "../lib/inventory-rust.ts";

const ONE_TEST = [
	"#[test]", // 1
	"fn adds_up() {", // 2
	"\tassert_eq!(1 + 1, 2);", // 3
	"}", // 4
].join("\n");

function ranges(result: {
	tests: ReadonlyArray<{ name: string; startLine: number; endLine: number }>;
}): Array<[string, number, number]> {
	return result.tests.map((def) => [def.name, def.startLine, def.endLine]);
}

describe("inventory: Rust test functions", () => {
	it("discovers one #[test] function and spans its attributes and body", () => {
		const result = discoverRustTests(ONE_TEST, "ui/src/lib.rs");

		assert.deepEqual(ranges(result), [["adds_up", 1, 4]]);
		assert.equal(result.tests[0].language, "rust");
		assert.equal(result.tests[0].file, "ui/src/lib.rs");
		assert.deepEqual(result.excluded, []);
	});

	it("hashes exactly the judged slice", () => {
		const [def] = discoverRustTests(ONE_TEST, "ui/src/lib.rs").tests;

		assert.equal(def.sourceSha256, sha256Hex(sliceSource(ONE_TEST, def)));
	});

	it("qualifies a name with the enclosing module chain", () => {
		const source = [
			"mod tests {", // 1
			"\t#[test]", // 2
			"\tfn a() {}", // 3
			"}", // 4
		].join("\n");

		assert.deepEqual(ranges(discoverRustTests(source, "ui/src/bash.rs")), [["tests > a", 2, 3]]);
	});

	it("nests module scopes outermost first", () => {
		const source = [
			"mod outer {", // 1
			"\tmod inner {", // 2
			"\t\t#[test]", // 3
			"\t\tfn x() {}", // 4
			"\t}", // 5
			"}",
		].join("\n");

		assert.deepEqual(ranges(discoverRustTests(source, "ui/src/lib.rs")), [
			["outer > inner > x", 3, 4],
		]);
	});

	it("discovers a tokio test attribute", () => {
		const source = [
			"#[tokio::test]", // 1
			"async fn fetches() {", // 2
			"\tassert!(true);", // 3
			"}",
		].join("\n");

		assert.deepEqual(ranges(discoverRustTests(source, "ui/src/ws.rs")), [["fetches", 1, 4]]);
	});

	it("discovers an attribute that shares the function line", () => {
		const result = discoverRustTests("#[test] fn inline() { assert!(true); }", "ui/src/lib.rs");

		assert.deepEqual(ranges(result), [["inline", 1, 1]]);
	});

	it("starts the range at the first attribute of the block", () => {
		const source = [
			"#[cfg(test)]", // 1
			'#[should_panic(expected = "boom")]', // 2
			"#[test]", // 3
			"fn panics() {", // 4
			'\tpanic!("boom");', // 5
			"}",
		].join("\n");

		assert.deepEqual(ranges(discoverRustTests(source, "ui/src/lib.rs")), [["panics", 1, 6]]);
	});

	it("excludes an ignored test as not run by default", () => {
		const source = [
			'#[ignore = "needs cheasee-pi on PATH"]', // 1
			"#[test]", // 2
			"fn gated() {", // 3
			"\tassert!(true);", // 4
			"}",
		].join("\n");

		const result = discoverRustTests(source, "ui/src/auth/tests.rs");

		assert.deepEqual(result.tests, []);
		assert.deepEqual(
			result.excluded.map((def) => [def.name, def.startLine, def.endLine]),
			[["gated", 1, 5]],
		);
		assert.equal(result.excluded[0].reason, "not-run-by-default");
	});

	it("ignores a function without a test attribute", () => {
		const source = ["fn helper() {", "\tassert!(true);", "}"].join("\n");

		const result = discoverRustTests(source, "ui/src/lib.rs");

		assert.deepEqual(result.tests, []);
		assert.deepEqual(result.excluded, []);
		assert.equal(declaresRustTest(source), false);
	});

	it("ignores a test attribute inside a line comment or a block comment", () => {
		const commented = ["// #[test]", "fn helper() {}"].join("\n");
		const block = ["/* outer /* #[test] */ still a comment */", "#[test]", "fn real() {}"].join(
			"\n",
		);

		assert.equal(declaresRustTest(commented), false);
		assert.deepEqual(ranges(discoverRustTests(commented, "ui/src/lib.rs")), []);
		assert.deepEqual(ranges(discoverRustTests(block, "ui/src/lib.rs")), [["real", 2, 3]]);
	});

	it("keeps a body intact when its literals carry braces and a fake attribute", () => {
		const source = [
			"#[test]", // 1
			"fn keeps_shape() {", // 2
			'\tlet s = "a } b";', // 3
			'\tlet raw = r#"#[test] } { "#;', // 4
			"\tassert_eq!(s.len(), 5);", // 5
			"}",
		].join("\n");

		const result = discoverRustTests(source, "ui/src/lib.rs");

		assert.deepEqual(ranges(result), [["keeps_shape", 1, 6]]);
	});

	it("does not mistake a lifetime or a char literal for a string", () => {
		const source = [
			"#[test]", // 1
			"fn char_braces() {", // 2
			"\tlet open: char = '{';", // 3
			"\tlet close: char = '}';", // 4
			'\tlet label: &\'static str = "x";', // 5
			"\tassert!(open != close);", // 6
			"}",
		].join("\n");

		assert.deepEqual(ranges(discoverRustTests(source, "ui/src/lib.rs")), [["char_braces", 1, 7]]);
	});

	it("follows a string literal continued across lines", () => {
		// A trailing backslash inside a string continues it onto the next line; a
		// scanner that ends the literal at the newline shifts every later range.
		const source = [
			"#[test]", // 1
			"fn continued() {", // 2
			'\tlet bytes = b"{\\"a\\":1}\\n\\', // 3
			'{\\"b\\":2}\\n";', // 4
			"\tassert!(!bytes.is_empty());", // 5
			"}", // 6
			"", // 7
			"#[test]", // 8
			"fn after() {", // 9
			"\tassert!(true);", // 10
			"}", // 11
		].join("\n");

		assert.deepEqual(ranges(discoverRustTests(source, "ui/src/lib.rs")), [
			["continued", 1, 6],
			["after", 8, 11],
		]);
	});

	it("discovers every test of a file in source order", () => {
		const source = [
			"mod tests {", // 1
			"\t#[test]", // 2
			"\tfn first() {}", // 3
			"", // 4
			"\t#[test]", // 5
			"\tfn second() {}", // 6
			"}",
		].join("\n");

		assert.deepEqual(ranges(discoverRustTests(source, "ui/src/lib.rs")), [
			["tests > first", 2, 3],
			["tests > second", 5, 6],
		]);
	});

	it("fails closed on an unterminated body", () => {
		const source = ["#[test]", "fn broken() {", "\tassert!(true);"].join("\n");

		assert.throws(
			() => discoverRustTests(source, "ui/src/lib.rs"),
			(err: unknown) => {
				assert.ok(err instanceof DiscoveryError);
				assert.match(err.message, /ui\/src\/lib\.rs:2/);
				assert.match(err.message, /unterminated/i);
				return true;
			},
		);
	});

	it("fails closed on a test attribute with no function to judge", () => {
		const source = ["#[test]", "fn real() {}", "", "#[test]"].join("\n");

		assert.throws(
			() => discoverRustTests(source, "ui/src/lib.rs"),
			(err: unknown) => {
				assert.ok(err instanceof DiscoveryError);
				assert.match(err.message, /ui\/src\/lib\.rs:4/);
				return true;
			},
		);
	});

	it("refuses a file that is not Rust", () => {
		assert.throws(
			() => discoverRustTests(ONE_TEST, "pkg/a_test.go"),
			(err: unknown) => {
				assert.ok(err instanceof DiscoveryError);
				assert.match(err.message, /not a Rust source file/);
				return true;
			},
		);
	});

	it("is deterministic for identical input", () => {
		assert.deepEqual(
			discoverRustTests(ONE_TEST, "ui/src/lib.rs"),
			discoverRustTests(ONE_TEST, "ui/src/lib.rs"),
		);
	});
});

describe("inventory: Rust dispatch", () => {
	it("maps .rs to rust", () => {
		assert.equal(languageOf("ui/src/main.rs"), "rust");
		assert.equal(languageOf("ui/tests/session.rs"), "rust");
	});

	it("detects a test file by its content, not by its name", () => {
		assert.equal(declaresRustTest(ONE_TEST), true);
		assert.equal(declaresRustTest("#[tokio::test]\nasync fn a() {}"), true);
		assert.equal(declaresRustTest("pub fn helper() {}"), false);
	});

	it("hands a Rust file to the Rust scanner", () => {
		const result = discoverInFile(ONE_TEST, "ui/src/lib.rs");

		assert.deepEqual(ranges(result), [["adds_up", 1, 4]]);
		assert.equal(result.tests[0].language, "rust");
	});

	it("reads a Rust source file with no test as an empty inventory, not a whole-file test", () => {
		const result = discoverInFile("pub fn helper() -> u8 {\n\t1\n}\n", "ui/src/lib.rs");

		assert.deepEqual(result.tests, []);
		assert.deepEqual(result.excluded, []);
	});
});
