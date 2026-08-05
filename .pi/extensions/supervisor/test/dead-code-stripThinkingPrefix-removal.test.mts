/**
 * Tests: Removal of dead function `stripThinkingPrefix` from agent/output.ts
 *
 * Dead-code analysis flagged `stripThinkingPrefix` as unused — zero call
 * sites. The underlying `THINKING_PREFIX_RE` const is LIVE (used inside
 * `extractLastJson`) and must NOT be deleted.
 *
 * Verifies:
 *   - `stripThinkingPrefix` is no longer defined in output.ts
 *   - `THINKING_PREFIX_RE` still exists and is still referenced inside
 *     `extractLastJson`
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-stripThinkingPrefix-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function readSource(relativePath: string): string {
	const path = resolve(dirname(fileURLToPath(import.meta.url)), "..", relativePath);
	return readFileSync(path, "utf8");
}

describe("agent/output.ts — dead stripThinkingPrefix removed", () => {
	const source = readSource("agent/output.ts");

	it("stripThinkingPrefix is no longer defined in output.ts", () => {
		assert.equal(
			source.includes("function stripThinkingPrefix("),
			false,
			"stripThinkingPrefix must be deleted from output.ts",
		);
	});

	it("THINKING_PREFIX_RE still exists (live const, do not delete)", () => {
		assert.equal(
			source.includes("const THINKING_PREFIX_RE = /^💭\\s*/gm;"),
			true,
			"THINKING_PREFIX_RE must be kept — it is used by extractLastJson",
		);
	});

	it("THINKING_PREFIX_RE is still referenced inside extractLastJson", () => {
		const extractSection = source.slice(source.indexOf("function extractLastJson"));
		assert.match(
			extractSection,
			/raw\.replace\(THINKING_PREFIX_RE, ""\)/,
			"extractLastJson must keep its THINKING_PREFIX_RE strip (live call site)",
		);
	});
});
