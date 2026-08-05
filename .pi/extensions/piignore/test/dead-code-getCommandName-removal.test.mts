/**
 * Tests: Removal of dead function `getCommandName` from piignore/index.ts
 *
 * Dead-code analysis flagged `getCommandName` (index.ts) as unused —
 * `checkBashCommand` calls `getCommandNameFromTokens` directly, and the
 * test file ships its own local copy.
 *
 * Verifies:
 *   - `getCommandName` is no longer defined in index.ts
 *   - `getCommandNameFromTokens` still exists (live callee, do not delete)
 *   - knip.ignoreIssues suppresses vendored `.pi/git/**` and fixture noise
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/piignore/test/dead-code-getCommandName-removal.test.mts
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

describe("piignore/index.ts — dead getCommandName removed", () => {
	const source = readSource("index.ts");

	it("getCommandName is no longer defined in index.ts", () => {
		assert.equal(
			source.includes("function getCommandName("),
			false,
			"getCommandName must be deleted from index.ts",
		);
	});

	it("getCommandNameFromTokens still exists (live callee, do not delete)", () => {
		assert.equal(
			source.includes("function getCommandNameFromTokens("),
			true,
			"getCommandNameFromTokens must be kept — it is called by checkBashCommand",
		);
	});
});

describe("knip.ignoreIssues — criterion 3 suppression config", () => {
	const packageJson = readSource("../../../package.json");

	it('knip.ignoreIssues contains ".pi/git/**" (vendored code suppression)', () => {
		assert.match(
			packageJson,
			/".pi\/git\/\*\*"\s*:\s*\[/,
			'knip.ignoreIssues must suppress .pi/git/** findings (explicit /** glob)',
		);
	});

	it('knip.ignoreIssues contains "**/test/fixtures/**" (fixture suppression)', () => {
		assert.match(
			packageJson,
			/"\*\*\/test\/fixtures\/\*\*"\s*:\s*\[/,
			'knip.ignoreIssues must suppress fixture findings (explicit /** glob)',
		);
	});

	it('knip.ignoreIssues entries use valid knip 6.x issue types (no stale invalid "default")', () => {
		assert.equal(
			packageJson.includes("\"default\""),
			false,
			'"default" is not a valid knip 6.x issue type and breaks knip entirely — stale entry must stay removed',
		);
	});
});
