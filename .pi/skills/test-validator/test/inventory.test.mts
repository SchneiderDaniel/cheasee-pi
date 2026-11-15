// Phase 1 — inventory resolves `node:test` call sites only.
// The entity is pure: source text in, definitions out, no filesystem access.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { DiscoveryError, discoverTests, sliceSource } from "../lib/inventory.ts";

const FILE = "src/example.test.mts";

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

const LINES = (text: string): string[] => text.split("\n");

/** Fixture helper: the exact inclusive line slice the definition claims. */
function sliceOf(source: string, def: { startLine: number; endLine: number }): string {
	return LINES(source)
		.slice(def.startLine - 1, def.endLine)
		.join("\n");
}

describe("inventory: discovery of node:test call sites", () => {
	it("returns one definition for a single `it` call spanning the call only", () => {
		const source = [
			'import { describe, it } from "node:test";',
			"",
			'it("adds numbers", () => {',
			"\tconst total = 1 + 1;",
			"\tif (total !== 2) throw new Error('nope');",
			"});",
		].join("\n");

		const result = discoverTests(source, FILE);

		assert.equal(result.tests.length, 1);
		assert.equal(result.excluded.length, 0);
		const [def] = result.tests;
		assert.equal(def.file, FILE);
		assert.equal(def.name, "adds numbers");
		assert.equal(def.startLine, 3);
		assert.equal(def.endLine, 6);
		assert.ok(def.startLine < def.endLine);
	});

	it("prefixes nested describe titles into the test name", () => {
		const source = [
			'import { describe, it } from "node:test";',
			'describe("outer", () => {',
			'\tdescribe("inner", () => {',
			'\t\tit("x", () => {});',
			"\t});",
			"});",
		].join("\n");

		const [def] = discoverTests(source, FILE).tests;

		assert.equal(def.name, "outer > inner > x");
	});

	it("discovers `test` and `spec` aliases and renamed imports", () => {
		const source = [
			'import { test, spec, it as check } from "node:test";',
			'test("via test", () => {});',
			'spec("via spec", () => {});',
			'check("via check", () => {});',
		].join("\n");

		const names = discoverTests(source, FILE).tests.map((def) => def.name);

		assert.deepEqual(names, ["via test", "via spec", "via check"]);
	});

	it("separates skip and todo into excluded while treating only as runnable", () => {
		const source = [
			'import { it } from "node:test";',
			'it("plain", () => {});',
			'it("options-skip", { skip: true }, () => {});',
			'it.skip("dot-skip", () => {});',
			'it.todo("todo-case");',
			'it.only("focused", () => {});',
		].join("\n");

		const result = discoverTests(source, FILE);

		assert.deepEqual(result.tests.map((def) => def.name).sort(), ["focused", "plain"]);
		assert.deepEqual(result.excluded.map((def) => [def.name, def.reason]).sort(), [
			["dot-skip", "skip"],
			["options-skip", "skip"],
			["todo-case", "todo"],
		]);
	});

	it("keeps a single definition for template and identifier names using raw text", () => {
		const source = [
			'import { it } from "node:test";',
			"const scenario = 'dynamic';",
			"it(`case ${scenario}`, () => {});",
			"it(scenario, () => {});",
		].join("\n");

		const result = discoverTests(source, FILE);

		assert.equal(result.tests.length, 2);
		assert.equal(result.tests[0].name, "`case ${scenario}`");
		assert.equal(result.tests[1].name, "scenario");
	});

	it("retains duplicate literal names as separate definitions", () => {
		const source = [
			'import { it } from "node:test";',
			'it("same", () => {});',
			'it("same", () => {});',
		].join("\n");

		const result = discoverTests(source, FILE);

		assert.equal(result.tests.length, 2);
		assert.notEqual(result.tests[0].startLine, result.tests[1].startLine);
	});

	it("ignores a call whose identifier is shadowed by a local declaration", () => {
		const source = [
			'import { it } from "node:test";',
			"function it(name: string, fn: () => void): void {",
			"\tvoid name;",
			"\tvoid fn;",
			"}",
			'it("shadowed", () => {});',
		].join("\n");

		const result = discoverTests(source, FILE);

		assert.deepEqual(result.tests, []);
	});

	it("ignores a call whose identifier is imported from another module", () => {
		const source = ['import { it } from "./helpers.ts";', 'it("not node:test", () => {});'].join(
			"\n",
		);

		assert.deepEqual(discoverTests(source, FILE).tests, []);
	});

	it("fails closed on a computed test call target, naming file and line", () => {
		const source = [
			'import { it } from "node:test";',
			'globalThis["it"]("computed", () => {});',
		].join("\n");

		assert.throws(
			() => discoverTests(source, FILE),
			(err: unknown) =>
				err instanceof DiscoveryError &&
				err.file === FILE &&
				err.line === 2 &&
				/computed/i.test(err.message),
		);
	});

	it("fails closed on syntactically invalid source without a partial result", () => {
		const source = ['import { it } from "node:test";', 'it("broken", () => {'].join("\n");

		let produced: unknown = null;
		assert.throws(() => {
			produced = discoverTests(source, FILE);
		}, DiscoveryError);
		assert.equal(produced, null);
	});

	it("returns empty arrays for a file with no call sites", () => {
		assert.deepEqual(discoverTests("", FILE), { tests: [], excluded: [] });
		assert.deepEqual(discoverTests('import { it } from "node:test";\n', FILE), {
			tests: [],
			excluded: [],
		});
	});

	it("hashes the exact inclusive source slice", () => {
		const source = ['import { it } from "node:test";', 'it("hashed", () => {});', ""].join("\n");
		const [def] = discoverTests(source, FILE).tests;

		assert.equal(def.sourceSha256, sha256(sliceOf(source, def)));
		assert.equal(sliceSource(source, def), sliceOf(source, def));

		const sameText = discoverTests(source, "other/place.test.mts").tests[0];
		assert.equal(sameText.sourceSha256, def.sourceSha256);

		const changed = discoverTests(source.replace("hashed", "hashed!"), FILE).tests[0];
		assert.notEqual(changed.sourceSha256, def.sourceSha256);
	});

	it("echoes the repository-relative path verbatim", () => {
		const source = 'import { it } from "node:test";\nit("x", () => {});';
		const relative = "./weird/../src/example.test.mts";

		assert.equal(discoverTests(source, relative).tests[0].file, relative);
	});

	it("is deterministic across repeated calls", () => {
		const source = [
			'import { describe, it } from "node:test";',
			'describe("a", () => {',
			'\tit("one", () => {});',
			'\tit.skip("two", () => {});',
			"});",
		].join("\n");

		assert.deepEqual(discoverTests(source, FILE), discoverTests(source, FILE));
	});
});
