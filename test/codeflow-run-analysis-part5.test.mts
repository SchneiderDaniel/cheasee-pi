// `run-analysis.mjs` is the headless producer and `makeReadFile` is its only
// filesystem read. Because a Rust facade (`x.rs`) plus its `x/` module children
// compile as one unit, that reader has to hand the filter the whole module —
// otherwise a finding the split merely moved keeps reporting as dead.

import assert from "node:assert";

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { after, before, describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

const RUNNER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");

// Importing must not run the producer: only a direct invocation does.
const { makeReadFile } = (await import(RUNNER)) as {
	makeReadFile: (dir: string) => (path: unknown) => string | null;
};

let root = "";

before(() => {
	root = mkdtempSync(join(tmpdir(), "codeflow-read-"));
	mkdirSync(join(root, "src", "retry"), { recursive: true });
	writeFileSync(join(root, "src", "retry.rs"), "mod wiring;\n");
	writeFileSync(join(root, "src", "retry", "wiring.rs"), "pub fn reconnect_delay() -> u64 { 1 }\n");
	mkdirSync(join(root, "src", "retry", "nested"), { recursive: true });
	writeFileSync(join(root, "src", "retry", "nested", "replay.rs"), "pub fn replay() {}\n");
	writeFileSync(join(root, "src", "plain.rs"), "fn alone() {}\n");
	writeFileSync(join(root, "a.test.mts"), "test('a', () => {});\n");
	writeFileSync(join(root, "a-part2.test.mts"), "test('b', () => {});\n");
});

after(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("run-analysis.mjs — the producer reads whole Rust modules", () => {
	it("is exported as a function and did not run the producer on import", () => {
		assert.strictEqual(typeof makeReadFile, "function");
	});

	it("folds a facade's child modules into its text", () => {
		const text = makeReadFile(root)("src/retry.rs");
		assert.match(String(text), /mod wiring;/);
		assert.match(String(text), /pub fn reconnect_delay/, "the child's definition must be visible");
		assert.match(String(text), /pub fn replay/, "nested children are part of the module too");
	});

	it("returns a child module's own text only", () => {
		assert.strictEqual(
			makeReadFile(root)("src/retry/wiring.rs"),
			"pub fn reconnect_delay() -> u64 { 1 }\n",
		);
	});

	it("leaves a facade with no module directory, and non-Rust peers, alone", () => {
		const read = makeReadFile(root);
		assert.strictEqual(read("src/plain.rs"), "fn alone() {}\n");
		assert.strictEqual(read("a.test.mts"), "test('a', () => {});\n");
	});

	it("keeps the containment guards", () => {
		const read = makeReadFile(root);
		assert.strictEqual(read("src/missing.rs"), null);
		assert.strictEqual(read("/etc/passwd"), null, "absolute paths are refused");
		assert.strictEqual(read("../escape.rs"), null, "traversal is refused");
		assert.strictEqual(read(""), null);
		assert.strictEqual(read(undefined), null);
		assert.strictEqual(read("toString"), null);
	});

	it("fails open when a module child cannot be read", () => {
		// A dangling child leaves the module incomplete, so the finding must stand
		// rather than be judged on half a module.
		const broken = mkdtempSync(join(tmpdir(), "codeflow-read-broken-"));
		try {
			mkdirSync(join(broken, "src", "m"), { recursive: true });
			writeFileSync(join(broken, "src", "m.rs"), "mod gone;\n");
			writeFileSync(join(broken, "src", "m", "gone.rs"), "fn x() {}\n");
			const read = makeReadFile(broken);
			assert.match(String(read("src/m.rs")), /fn x/);
			rmSync(join(broken, "src", "m", "gone.rs"));
			symlinkSync(join(broken, "src", "absent.rs"), join(broken, "src", "m", "gone.rs"));
			assert.strictEqual(read("src/m.rs"), null, "an unreadable child must void the module");
		} finally {
			rmSync(broken, { recursive: true, force: true });
		}
	});
});
