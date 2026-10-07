/**
 * Tests: Removal of test-only Phase-1 module config/diagnostics.ts
 *
 * The module was speculative "Phase 1" scaffolding with zero production
 * consumers — only its own test imported it. Both exports
 * (`detectEventGap`, `buildErrorNotificationContext`) died with the module;
 * the "idle detection" promised in its header was never built. Deleted per
 * issue #1606 (delete AC).
 *
 * Verifies:
 *   - config/diagnostics.ts no longer exists on disk
 *   - test/diagnostics.test.mts no longer exists on disk
 *   - zero occurrences of `config/diagnostics` anywhere under supervisor/
 *   - zero occurrences of `detectEventGap` / `buildErrorNotificationContext`
 *   - config/ retains exactly types.ts, config.ts, merge.ts, workflow.ts
 *     (no barrel index.ts appears)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-diagnostics-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importersOf, declarersOf } from "../../lib/test/source-graph.ts";

const SUPERVISOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("config/diagnostics.ts — dead module removed", () => {
	it("config/diagnostics.ts no longer exists on disk", () => {
		const path = join(SUPERVISOR_ROOT, "config", "diagnostics.ts");
		assert.equal(existsSync(path), false, "config/diagnostics.ts must be deleted");
	});

	it("test/diagnostics.test.mts no longer exists on disk", () => {
		const path = join(SUPERVISOR_ROOT, "test", "diagnostics.test.mts");
		assert.equal(existsSync(path), false, "test/diagnostics.test.mts must be deleted");
	});

	it("no file imports config/diagnostics (no dangling module edge)", () => {
		assert.deepEqual(
			importersOf(SUPERVISOR_ROOT, "config/diagnostics"),
			[],
			"no source may import ../config/diagnostics.ts",
		);
	});

	it("detectEventGap / buildErrorNotificationContext are no longer declared", () => {
		for (const name of ["detectEventGap", "buildErrorNotificationContext"]) {
			assert.deepEqual(
				declarersOf(SUPERVISOR_ROOT, name),
				[],
				`${name} must die with the removed module`,
			);
		}
	});

	it("config/ retains exactly types.ts, config.ts, merge.ts, workflow.ts", () => {
		const files = readdirSync(join(SUPERVISOR_ROOT, "config"))
			.filter((f) => f.endsWith(".ts"))
			.sort();
		assert.deepEqual(files, ["config.ts", "merge.ts", "types.ts", "workflow.ts"]);
	});
});