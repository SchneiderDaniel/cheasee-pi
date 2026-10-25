// The served page resolves sources by path only, so a file split into a module
// directory (`x.rs` + `x/mod.rs` + `x/child.rs`) left the facade hollow and the
// browser filter kept findings the moved reference disproves. `moduleChildPaths`
// is the one home for that rule and `readFileFrom` applies it: these cases pin
// the convention, not a test-only expansion.

import assert from "node:assert";

import { createRequire } from "node:module";

import { dirname, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

const requireCjs = createRequire(import.meta.url);

const FILTER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js");

const { moduleChildPaths, readFileFrom } = requireCjs(FILTER) as {
	moduleChildPaths: (logicalPath: unknown, candidates: unknown) => string[];
	readFileFrom: (data: unknown) => (path: unknown) => string | null;
};

describe("fp-filter — module child paths are one logical Rust module", () => {
	it("lists the children of a facade, excluding the facade itself", () => {
		assert.deepStrictEqual(
			moduleChildPaths("src/retry.rs", [
				"src/retry.rs",
				"src/retry/wiring.rs",
				"src/retry/tests.rs",
			]),
			["src/retry/tests.rs", "src/retry/wiring.rs"],
		);
	});

	it("keeps the directory and reaches nested children", () => {
		assert.deepStrictEqual(
			moduleChildPaths("src/rpc/client.rs", ["src/rpc/client/part2.rs", "src/rpc/client.rs"]),
			["src/rpc/client/part2.rs"],
		);
		assert.deepStrictEqual(moduleChildPaths("src/stream.rs", ["src/stream/assembler/replay.rs"]), [
			"src/stream/assembler/replay.rs",
		]);
	});

	it("sorts numerically ordered part names ascending", () => {
		assert.deepStrictEqual(moduleChildPaths("a.rs", ["a/part10.rs", "a/part2.rs"]), [
			"a/part10.rs",
			"a/part2.rs",
		]);
	});

	it("does not treat same-directory siblings as module children", () => {
		assert.deepStrictEqual(moduleChildPaths("src/retry.rs", ["src/retry_part2.rs"]), []);
		assert.deepStrictEqual(
			moduleChildPaths("x.test.mts", ["x-part2.test.mts"]),
			[],
			"a dash part is a peer file, not a spliced child",
		);
		assert.deepStrictEqual(
			moduleChildPaths("codeflow/server.py", ["codeflow/server_config.py"]),
			[],
		);
	});

	it("returns [] for unusable input instead of throwing", () => {
		for (const bad of ["", undefined, null, 7, {}]) {
			assert.deepStrictEqual(moduleChildPaths(bad, ["a/b.rs"]), []);
		}
		assert.deepStrictEqual(moduleChildPaths("a.rs", undefined), []);
		assert.deepStrictEqual(moduleChildPaths("a.rs", "a/b.rs"), []);
	});
});

describe("fp-filter — readFileFrom resolves the logical module", () => {
	const served = {
		files: [
			{ path: "src/retry.rs", content: null, piFpSource: "mod wiring;\n" },
			{ path: "src/retry/wiring.rs", content: null, piFpSource: "fn dead() {}\n" },
			{ path: "src/retry/tests.rs", content: null, piFpSource: "fn t() { dead(); }\n" },
			{ path: "x.test.mts", content: null, piFpSource: "test('a', () => {});\n" },
			{ path: "x-part2.test.mts", content: null, piFpSource: "test('b', () => {});\n" },
		],
	};

	it("folds a facade's child modules into its text", () => {
		const text = readFileFrom(served)("src/retry.rs");
		assert.ok(text !== null, "a present facade must resolve");
		assert.match(text, /mod wiring;/);
		assert.match(text, /fn dead\(\) \{\}/, "the moved definition must be visible");
		assert.match(text, /fn t\(\) \{ dead\(\); \}/, "the moved reference must be visible");
	});

	it("returns a child's own text only, never its parent's", () => {
		const text = readFileFrom(served)("src/retry/wiring.rs");
		assert.strictEqual(text, "fn dead() {}\n");
	});

	it("leaves non-Rust peers unfolded", () => {
		assert.strictEqual(readFileFrom(served)("x.test.mts"), "test('a', () => {});\n");
	});

	it("still returns null for absent and unusable paths", () => {
		const read = readFileFrom(served);
		assert.strictEqual(read("src/retry/missing.rs"), null);
		assert.strictEqual(read(""), null);
		assert.strictEqual(read(undefined), null);
		assert.strictEqual(read("toString"), null, "prototype keys must not leak");
	});

	it("suppresses a dead function whose only reference moved into a child module", () => {
		const data = {
			files: [
				{ path: "src/retry.rs", content: null, piFpSource: "\n" },
				{ path: "src/retry/child.rs", content: null, piFpSource: "fn use_it() { dead(); }\n" },
			],
			stats: { functions: 2, dead: 1 },
			deadFunctions: [{ name: "dead", file: "src/retry.rs" }],
		};
		const { sanitizeAnalysisData } = requireCjs(FILTER) as {
			sanitizeAnalysisData: (
				data: unknown,
				readFile?: (path: unknown) => string | null,
			) => {
				data: { deadFunctions: any[]; stats: { dead: number } };
				suppressed: { deadCode: any[] };
			};
		};
		const { data: clean, suppressed } = sanitizeAnalysisData(data, readFileFrom(data));
		assert.deepStrictEqual(suppressed.deadCode, [{ name: "dead", file: "src/retry.rs" }]);
		assert.deepStrictEqual(clean.deadFunctions, []);
		assert.strictEqual(clean.stats.dead, 0);
	});
});
