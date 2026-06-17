/**
 * Tests: structural-analyzer manifest cleanup
 *
 * Verifies that @earendil-works/pi-ai zombie peer dependency is removed.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "..", "package.json");

describe("structural-analyzer manifest", () => {
	let pkg: Record<string, unknown>;
	let raw: string;

	it("package.json parses as valid JSON (no syntax error)", () => {
		raw = readFileSync(packageJsonPath, "utf-8");
		pkg = JSON.parse(raw);
	});

	it("peerDependencies is an object", () => {
		const peerDeps = pkg.peerDependencies;
		assert.ok(peerDeps !== null && typeof peerDeps === "object" && !Array.isArray(peerDeps));
	});

	it("peerDependencies has exactly two entries: @earendil-works/pi-coding-agent and typebox", () => {
		const peerDeps = pkg.peerDependencies as Record<string, string>;
		const keys = Object.keys(peerDeps);
		assert.strictEqual(
			keys.length,
			2,
			`Expected 2 peer deps, got ${keys.length}: ${keys.join(", ")}`,
		);
		assert.ok("@earendil-works/pi-coding-agent" in peerDeps);
		assert.ok("typebox" in peerDeps);
	});

	it("@earendil-works/pi-ai is absent from peerDependencies (not a key)", () => {
		const peerDeps = pkg.peerDependencies as Record<string, string>;
		assert.ok(!("@earendil-works/pi-ai" in peerDeps));
	});

	it("@earendil-works/pi-ai appears 0 times in the raw file content (string-level guard)", () => {
		const count = (raw.match(/@earendil-works\/pi-ai/g) || []).length;
		assert.strictEqual(count, 0, `Expected 0 occurrences of @earendil-works/pi-ai, found ${count}`);
	});

	it('remaining peer dep entries preserve their "*" range strings unchanged', () => {
		const peerDeps = pkg.peerDependencies as Record<string, string>;
		assert.strictEqual(peerDeps["@earendil-works/pi-coding-agent"], "*");
		assert.strictEqual(peerDeps["typebox"], "*");
	});
});
