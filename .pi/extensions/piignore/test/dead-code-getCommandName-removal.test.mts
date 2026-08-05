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

	// knip 6.x schema requires array values (zod: z.record(z.string(),
	// z.array(issueTypeSchema))); "*" is rejected with "expected: array" and
	// the pre-existing "default" type is likewise invalid — both make knip
	// exit 2 with no stdout (dead-code gate status "error").
	it('knip.ignoreIssues contains ".pi/git/**" (vendored code suppression, explicit /** glob)', () => {
		assert.match(
			packageJson,
			/".pi\/git\/\*\*"\s*:\s*\[/,
			'knip.ignoreIssues must suppress .pi/git/** findings (explicit /** glob, array of valid issue types)',
		);
	});

	it('knip.ignoreIssues contains "**/test/fixtures/**" (fixture suppression, explicit /** glob)', () => {
		assert.match(
			packageJson,
			/"\*\*\/test\/fixtures\/\*\*"\s*:\s*\[/,
			'knip.ignoreIssues must suppress fixture findings (explicit /** glob, array of valid issue types)',
		);
	});

	it('knip.ignoreIssues uses only valid knip 6 issue types (no "*", no stale "default")', () => {
		assert.equal(
			packageJson.includes('"default"'),
			false,
			'"default" is not a valid knip 6.x issue type and makes knip exit 2 with no stdout — it must be migrated to a valid type',
		);
	});
});
