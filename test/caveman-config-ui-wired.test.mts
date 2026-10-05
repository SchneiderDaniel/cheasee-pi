/**
 * Wiring guard for the caveman config-ui theme.style adoption (#1789).
 *
 * The AC 1/2/3 guard suite at .pi/extensions/caveman/test/config-ui.test.ts
 * existed and passed standalone, but was absent from package.json scripts.test
 * so `npm test` (and the pipeline gate) never ran it. This asserts the wiring
 * stays in place, and lives OUTSIDE the guard file so removing the entry cannot
 * silently remove its own check.
 *
 * Run with:
 *   node --experimental-strip-types --test test/caveman-config-ui-wired.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GUARD_PATH = ".pi/extensions/caveman/test/config-ui.test.ts";

function testScriptTokens(): string[] {
	const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")) as {
		scripts?: { test?: string };
	};
	return String(pkg.scripts?.test ?? "")
		.split(/\s+/)
		.filter(Boolean);
}

describe("caveman config-ui guard is wired into npm test (#1789)", () => {
	it("package.json scripts.test includes the config-ui guard exactly once", () => {
		assert.ok(existsSync(resolve(REPO_ROOT, GUARD_PATH)), "config-ui guard file must exist");
		const occurrences = testScriptTokens().filter((t) => t === GUARD_PATH).length;
		assert.strictEqual(
			occurrences,
			1,
			`config-ui guard not wired into npm test (found ${occurrences} occurrences of ${GUARD_PATH})`,
		);
	});

	it("fails on a simulated regression where the guard entry is removed (TDD gate)", () => {
		const simulated = testScriptTokens().filter((t) => t !== GUARD_PATH);
		assert.ok(
			!simulated.includes(GUARD_PATH),
			"removing the token must make the wiring check fail",
		);
	});
});
