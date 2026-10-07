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
import { existsSync } from "node:fs";
import { resolve, matchesGlob } from "node:path";

import { isRegistered, parseTokens, testScript } from "./lib/test-discovery.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GUARD_PATH = ".pi/extensions/caveman/test/config-ui.test.ts";

describe("caveman config-ui guard is wired into npm test (#1789)", () => {
	it("npm test globs register the config-ui guard", () => {
		assert.ok(existsSync(resolve(REPO_ROOT, GUARD_PATH)), "config-ui guard file must exist");
		assert.ok(
			isRegistered(GUARD_PATH),
			`config-ui guard not registered by npm test globs: ${GUARD_PATH}`,
		);
	});

	it("fails on a simulated regression where the guard glob is dropped (TDD gate)", () => {
		const withoutTsGlob = parseTokens(testScript()).filter((g) => !g.endsWith(".test.ts"));
		assert.strictEqual(
			withoutTsGlob.some((g) => matchesGlob(GUARD_PATH, g)),
			false,
			"removing the .test.ts glob must uncover the guard",
		);
	});
});
