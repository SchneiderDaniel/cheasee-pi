// Phase 1c — the repository-wide test inventory.
//
// The audit may only claim to have judged "every runnable test" when it has
// enumerated every test file the repository runs: node test files under the npm
// runner globs, Go `_test.go` files, Python test modules, and shell test
// scripts. Every enumerated file must contribute at least one inventory entry,
// so a file can never silently drop out of the completion gate.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { discoverRepository, listTestFiles } from "../lib/inventory-repository.ts";
import { DiscoveryError } from "../lib/inventory.ts";

const TS_TESTS = [
	'import { describe, it } from "node:test";',
	'describe("suite", () => {',
	'\tit("keeps total", () => {',
	"\t\tassert.equal(1, 1);",
	"\t});",
	"});",
].join("\n");

const GO_TESTS = [
	"package demo",
	"",
	'import "testing"',
	"",
	"func TestAdds(t *testing.T) {",
	"\tif add(1, 2) != 3 {",
	'\t\tt.Fatal("bad")',
	"\t}",
	"}",
].join("\n");

const PY_TESTS = ["def test_total():", "    assert total() == 2", ""].join("\n");

const SH_TESTS = ["#!/usr/bin/env bash", "set -euo pipefail", "test -f a && echo ok", ""].join(
	"\n",
);

interface Fixture {
	readonly dir: string;
	cleanup(): void;
}

function repo(files: Record<string, string>): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "test-validator-inventory-"));
	for (const [relative, content] of Object.entries(files)) {
		const path = join(dir, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	}
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function standardRepo(extra: Record<string, string> = {}): Fixture {
	return repo({
		"package.json": JSON.stringify({ scripts: { test: "node --test 'src/*.test.mts'" } }),
		"src/a.test.mts": TS_TESTS,
		"go.mod": "module example.test/demo\n",
		"cmd/app/add_test.go": GO_TESTS,
		"cmd/app/helpers_test.go": "package demo\n\nfunc add(a, b int) int { return a + b }\n",
		"test/test_cart.py": PY_TESTS,
		"test/no-submodules.test.sh": SH_TESTS,
		"src/cart.ts": "export function total(): number {\n\treturn 2;\n}\n",
		...extra,
	});
}

async function within(fixture: Fixture, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
	} finally {
		fixture.cleanup();
	}
}

describe("inventory-repository: which files are test files", () => {
	it("finds node, Go, Python, and shell test files", async () => {
		const fixture = standardRepo();
		await within(fixture, () => {
			const files = listTestFiles(fixture.dir, []);

			assert.deepEqual(files, [
				"cmd/app/add_test.go",
				"cmd/app/helpers_test.go",
				"src/a.test.mts",
				"test/no-submodules.test.sh",
				"test/test_cart.py",
			]);
		});
	});

	it("ignores dependency, cache, and output directories", async () => {
		const fixture = standardRepo({
			"node_modules/pkg/a.test.mjs": "x",
			"ignore/old/a.test.mts": TS_TESTS,
			"vendor/lib/a_test.go": GO_TESTS,
			".git/a.test.mts": TS_TESTS,
			"__pycache__/test_a.py": PY_TESTS,
		});
		await within(fixture, () => {
			const files = listTestFiles(fixture.dir, []);
			for (const skipped of ["node_modules", "ignore/old", "vendor", ".git", "__pycache__"]) {
				assert.equal(
					files.some((file) => file.includes(skipped)),
					false,
					`${skipped} must not be inventoried`,
				);
			}
		});
	});

	it("only counts Go test files when the repository is a Go module", async () => {
		const fixture = repo({
			"package.json": JSON.stringify({ scripts: { test: "node --test 'src/*.test.mts'" } }),
			"src/a.test.mts": TS_TESTS,
			"cmd/app/add_test.go": GO_TESTS,
		});
		await within(fixture, () => {
			assert.deepEqual(listTestFiles(fixture.dir, []), ["src/a.test.mts"]);
		});
	});

	it("unions the runner's own globs with the conventional names", async () => {
		const fixture = standardRepo({ "spec/cart.spec.mts": TS_TESTS });
		await within(fixture, () => {
			const files = listTestFiles(fixture.dir, ["spec/*.spec.mts"]);

			assert.equal(files.includes("spec/cart.spec.mts"), true);
			assert.equal(files.includes("src/a.test.mts"), true);
		});
	});

	it("is deterministic: the same tree yields the same order", async () => {
		const fixture = standardRepo();
		await within(fixture, () => {
			assert.deepEqual(listTestFiles(fixture.dir, []), listTestFiles(fixture.dir, []));
		});
	});
});

describe("inventory-repository: the inventory covers every listed file", () => {
	it("contributes at least one entry per test file and loads every source", async () => {
		const fixture = standardRepo();
		await within(fixture, () => {
			const result = discoverRepository({ cwd: fixture.dir });

			for (const file of result.files) {
				const entries = [
					...result.inventory.tests.filter((def) => def.file === file),
					...result.inventory.excluded.filter((def) => def.file === file),
				];
				assert.ok(entries.length >= 1, `${file} contributed nothing to the inventory`);
				assert.equal(result.sources.has(file), true, `${file} has no loaded source`);
			}
			assert.equal(result.files.includes("src/cart.ts"), false, "production files are not tests");
		});
	});

	it("tallies what it found per language", async () => {
		const fixture = standardRepo();
		await within(fixture, () => {
			const result = discoverRepository({ cwd: fixture.dir });

			assert.equal(result.byLanguage.typescript.tests, 1);
			assert.equal(result.byLanguage.go.tests, 1);
			assert.equal(result.byLanguage.go.excluded, 1);
			assert.equal(result.byLanguage.python.tests, 1);
			assert.equal(result.byLanguage.shell.tests, 1);
			assert.equal(result.byLanguage.go.files, 2);
			assert.equal(result.byLanguage.shell.files, 1);
		});
	});

	it("halts on an unparsable test file instead of skipping it", async () => {
		const fixture = standardRepo({ "src/broken.test.mts": '\nit("broken", () => {' });
		await within(fixture, () => {
			assert.throws(
				() => discoverRepository({ cwd: fixture.dir }),
				(err: unknown) => {
					assert.ok(err instanceof DiscoveryError);
					assert.match(err.message, /src\/broken\.test\.mts/);
					return true;
				},
			);
		});
	});

	it("halts when the repository has no test files at all", async () => {
		const fixture = repo({ "package.json": JSON.stringify({ name: "empty" }) });
		await within(fixture, () => {
			assert.throws(
				() => discoverRepository({ cwd: fixture.dir }),
				(err: unknown) => {
					assert.ok(err instanceof DiscoveryError);
					assert.match(err.message, /no test files/i);
					return true;
				},
			);
		});
	});

	it("reports how many definitions a pilot limit left out", async () => {
		const fixture = standardRepo();
		await within(fixture, () => {
			const result = discoverRepository({ cwd: fixture.dir, limit: 1 });

			assert.equal(result.inventory.tests.length, 1);
			assert.ok(result.truncated > 0);
		});
	});

	it("keeps excluded entries when a pilot limit truncates the tests", async () => {
		const fixture = standardRepo();
		await within(fixture, () => {
			const result = discoverRepository({ cwd: fixture.dir, limit: 1 });

			assert.equal(
				result.inventory.excluded.some((entry) => entry.reason === "test-support-file"),
				true,
			);
		});
	});
});
