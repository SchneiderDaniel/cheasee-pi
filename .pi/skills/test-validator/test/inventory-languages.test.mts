// Phase 1b — discovery covers every runnable test file in the repository, not
// only `node:test` call sites: Go `_test.go` files, Python test modules, and
// shell test scripts are inventoried too, and a runnable file with no
// statically enumerable call site becomes one whole-file definition instead of
// silently disappearing from the inventory.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { discoverGoTests } from "../lib/inventory-go.ts";
import { discoverPythonTests } from "../lib/inventory-python.ts";
import { discoverInFile, languageOf } from "../lib/inventory-file.ts";
import { DiscoveryError } from "../lib/inventory.ts";
import type { InventoryResult } from "../lib/types.ts";

const GO_SOURCE = [
	"package demo",
	"",
	'import "testing"',
	"",
	"func TestAddsTotals(t *testing.T) {",
	"\ttotal := add(1, 2)",
	"\tif total != 3 {",
	'\t\tt.Fatalf("unexpected: %d", total)',
	"\t}",
	"}",
].join("\n");

const PY_SOURCE = [
	"import unittest",
	"",
	"class TestCart(unittest.TestCase):",
	"    def test_total(self):",
	"        self.assertEqual(total(), 2)",
	"        self.assertTrue(True)",
	"",
	"    def helper(self):",
	"        return 1",
	"",
	"",
	"def test_module_level():",
	"    assert True",
].join("\n");

const SH_SOURCE = ["#!/usr/bin/env bash", "set -euo pipefail", 'echo "ok"', ""].join("\n");

function names(result: InventoryResult): string[] {
	return result.tests.map((def) => def.name);
}

describe("inventory: Go test files", () => {
	it("finds a top-level Test function with its inclusive range", () => {
		const result = discoverGoTests(GO_SOURCE, "cmd/app/add_test.go");

		assert.equal(result.tests.length, 1);
		const [def] = result.tests;
		assert.equal(def.name, "TestAddsTotals");
		assert.equal(def.startLine, 5);
		assert.equal(def.endLine, 10);
		assert.equal(def.file, "cmd/app/add_test.go");
		assert.equal(def.language, "go");
	});

	it("finds every Test function in one file, with distinct ranges", () => {
		const source = [
			"package demo",
			"",
			"func TestOne(t *testing.T) {",
			"\t_ = 1",
			"}",
			"",
			"func TestTwo(t *testing.T) {",
			"\t_ = 2",
			"}",
		].join("\n");

		const result = discoverGoTests(source, "a_test.go");

		assert.deepEqual(names(result), ["TestOne", "TestTwo"]);
		assert.deepEqual(
			result.tests.map((def) => [def.startLine, def.endLine]),
			[
				[3, 5],
				[7, 9],
			],
		);
	});

	it("ignores braces inside strings, raw strings, runes, and comments", () => {
		const source = [
			"package demo", // 1
			"", // 2
			"func TestBraces(t *testing.T) {", // 3
			'\tmsg := "}{ not a brace"', // 4
			'\traw := `}"`', // 5
			"\tnested := func() { _, _ = msg, raw }()", // 6
			"\t// } a comment close brace", // 7
			"\t/* } */ _ = nested", // 8
			"}", // 9
			"", // 10
			"func TestNext(t *testing.T) {}", // 11
		].join("\n");

		const result = discoverGoTests(source, "a_test.go");

		assert.deepEqual(names(result), ["TestBraces", "TestNext"]);
		assert.equal(result.tests[0].endLine, 9);
		assert.equal(result.tests[1].startLine, 11);
		assert.equal(result.tests[1].endLine, 11);
	});

	it("counts a one-line Test function as a single-line definition", () => {
		const result = discoverGoTests("package demo\n\nfunc TestTiny(t *testing.T) {}\n", "a_test.go");

		assert.deepEqual(
			result.tests.map((def) => [def.startLine, def.endLine]),
			[[3, 3]],
		);
	});

	it("discovers Fuzz functions and excludes benchmarks as not run by default", () => {
		const source = [
			"package demo",
			"",
			"func FuzzAdd(f *testing.F) {",
			"\tf.Add(1, 2)",
			"}",
			"",
			"func BenchmarkAdd(b *testing.B) {",
			"\tfor i := 0; i < b.N; i++ {",
			"\t\tadd(1, 2)",
			"\t}",
			"}",
		].join("\n");

		const result = discoverGoTests(source, "a_test.go");

		assert.deepEqual(names(result), ["FuzzAdd"]);
		assert.deepEqual(
			result.excluded.map((entry) => [entry.name, entry.reason]),
			[["BenchmarkAdd", "not-run-by-default"]],
		);
	});

	it("reports a file with no runnable entry point as test support", () => {
		const source = ["package demo", "", "func add(a, b int) int {", "\treturn a + b", "}"].join(
			"\n",
		);

		const result = discoverGoTests(source, "helpers_test.go");

		assert.deepEqual(result.tests, []);
		assert.deepEqual(
			result.excluded.map((entry) => [entry.name, entry.reason]),
			[["helpers_test.go", "test-support-file"]],
		);
	});

	it("fails closed on an unterminated function body", () => {
		const source = ["package demo", "", "func TestHalf(t *testing.T) {", "\tt.Log(1)"].join("\n");

		assert.throws(
			() => discoverGoTests(source, "pkg/half_test.go"),
			(err: unknown) => {
				assert.ok(err instanceof DiscoveryError);
				assert.match(err.message, /pkg\/half_test\.go:3/);
				assert.match(err.message, /unterminated/);
				return true;
			},
		);
	});

	it("does not treat a lowercase-suffixed function as a test", () => {
		// `go test` only runs Test/Fuzz/Example/Benchmark followed by a name that
		// does not start with a lowercase letter.
		const source = [
			"package demo",
			"",
			"func Testhelper(t *testing.T) {}",
			"func Test_underscore(t *testing.T) {}",
		].join("\n");

		const result = discoverGoTests(source, "a_test.go");

		assert.deepEqual(names(result), ["Test_underscore"]);
	});
});

describe("inventory: Python test modules", () => {
	it("finds module-level and class-based test functions", () => {
		const result = discoverPythonTests(PY_SOURCE, "test/cart_test.py");

		assert.deepEqual(names(result), ["TestCart > test_total", "test_module_level"]);
		assert.deepEqual(
			result.tests.map((def) => [def.startLine, def.endLine]),
			[
				[4, 6],
				[12, 13],
			],
		);
		assert.equal(result.tests[0].language, "python");
	});

	it("finds async test functions", () => {
		const source = ["import asyncio", "", "async def test_fetch():", "    await run()"].join("\n");

		assert.deepEqual(names(discoverPythonTests(source, "test_net.py")), ["test_fetch"]);
	});

	it("includes decorators in the definition range", () => {
		const source = [
			"import pytest",
			"",
			'@pytest.mark.parametrize("x", [1, 2])',
			"def test_param(x):",
			"    assert x",
		].join("\n");

		const result = discoverPythonTests(source, "test_p.py");

		assert.deepEqual(
			result.tests.map((def) => [def.startLine, def.endLine]),
			[[3, 5]],
		);
	});

	it("stops a body at the next sibling definition and drops trailing blanks", () => {
		const source = [
			"def test_a():", // 1
			"    assert 1", // 2
			"", // 3
			"", // 4
			"def test_b():", // 5
			"    assert 2", // 6
			"", // 7
		].join("\n");

		const result = discoverPythonTests(source, "test_ab.py");

		assert.deepEqual(
			result.tests.map((def) => [def.name, def.startLine, def.endLine]),
			[
				["test_a", 1, 2],
				["test_b", 5, 6],
			],
		);
	});

	it("reports a script-style test module as one whole-file test", () => {
		const source = ["#!/usr/bin/env python3", "assert True", "print('ok')"].join("\n");

		const result = discoverInFile(source, "test/dependency-check.test.py");

		assert.equal(result.tests.length, 1);
		assert.equal(result.tests[0].name, "dependency-check.test.py");
		assert.equal(result.tests[0].language, "python");
		assert.deepEqual([result.tests[0].startLine, result.tests[0].endLine], [1, 3]);
	});
});

describe("inventory: shell test scripts", () => {
	it("treats the script as one runnable test", () => {
		const result = discoverInFile(SH_SOURCE, "test/no-submodules.test.sh");

		assert.equal(result.tests.length, 1);
		const [def] = result.tests;
		assert.equal(def.name, "no-submodules.test.sh");
		assert.equal(def.language, "shell");
		assert.deepEqual([def.startLine, def.endLine], [1, 3]);
	});
});

describe("inventory: dispatch by file kind", () => {
	it("maps extensions to a language", () => {
		assert.equal(languageOf("src/a.test.mts"), "typescript");
		assert.equal(languageOf("src/a.test.js"), "typescript");
		assert.equal(languageOf("pkg/a_test.go"), "go");
		assert.equal(languageOf("test/test_a.py"), "python");
		assert.equal(languageOf("test/a.test.sh"), "shell");
		assert.equal(languageOf("data/a.txt"), null);
	});

	it("uses node:test call sites when a file has them", () => {
		const source = [
			'import { describe, it } from "node:test";',
			'describe("suite", () => {',
			'\tit("keeps total", () => {',
			"\t\tassert.equal(1, 1);",
			"\t});",
			"});",
		].join("\n");

		const result = discoverInFile(source, "src/a.test.mts");

		assert.deepEqual(names(result), ["suite > keeps total"]);
		assert.equal(result.tests[0].language, "typescript");
	});

	it("falls back to one whole-file definition for a runnable file with no call site", () => {
		const source = [
			"// custom harness, no node:test",
			"runHarness([",
			'  { name: "first", run: () => {} },',
			"]);",
			"",
		].join("\n");

		const result = discoverInFile(source, "docker/test/harness.test.mts");

		assert.deepEqual(names(result), ["harness.test.mts"]);
		assert.deepEqual([result.tests[0].startLine, result.tests[0].endLine], [1, 4]);
	});

	it("fails closed on a file kind it cannot enumerate", () => {
		assert.throws(
			() => discoverInFile("puts 'hi'", "spec/a_spec.rb"),
			(err: unknown) => {
				assert.ok(err instanceof DiscoveryError);
				assert.match(err.message, /a_spec\.rb/);
				return true;
			},
		);
	});

	it("propagates a parse failure instead of returning a partial inventory", () => {
		assert.throws(
			() =>
				discoverInFile('import { it } from "node:test";\nit("broken", () => {', "src/b.test.mts"),
			DiscoveryError,
		);
	});

	it("never returns an empty inventory for a runnable file", () => {
		const samples: Array<[string, string]> = [
			["src/a.test.mts", 'import { it } from "node:test";\nit("a", () => {});'],
			["src/empty.test.mts", ""],
			["pkg/a_test.go", "package demo\n"],
			["test/test_a.py", "def test_a():\n    assert 1\n"],
			["test/a.test.sh", "#!/bin/sh\ntrue\n"],
		];

		for (const [file, source] of samples) {
			const result = discoverInFile(source, file);
			assert.ok(
				result.tests.length + result.excluded.length >= 1,
				`${file} must contribute at least one inventory entry`,
			);
		}
	});

	it("is deterministic for identical input", () => {
		assert.deepEqual(
			discoverInFile(GO_SOURCE, "a_test.go"),
			discoverInFile(GO_SOURCE, "a_test.go"),
		);
		assert.deepEqual(
			discoverInFile(PY_SOURCE, "test_a.py"),
			discoverInFile(PY_SOURCE, "test_a.py"),
		);
	});
});
