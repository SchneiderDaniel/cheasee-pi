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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SUPERVISOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
	const entries: string[] = [];
	for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
		const full = join(dir, entry);
		if (statSync(full).isFile()) entries.push(full);
	}
	return entries;
}

function readAllSources(): string[] {
	const skip = (p: string) =>
		p.includes(`${sep}fixtures${sep}`) || p.endsWith("dead-code-diagnostics-removal.test.mts");
	return walk(SUPERVISOR_ROOT)
		.filter((p) => p.endsWith(".ts") || p.endsWith(".mts"))
		.filter((p) => !skip(p))
		.map((p) => readFileSync(p, "utf8"));
}

describe("config/diagnostics.ts — dead module removed", () => {
	it("config/diagnostics.ts no longer exists on disk", () => {
		const path = join(SUPERVISOR_ROOT, "config", "diagnostics.ts");
		assert.equal(existsSync(path), false, "config/diagnostics.ts must be deleted");
	});

	it("test/diagnostics.test.mts no longer exists on disk", () => {
		const path = join(SUPERVISOR_ROOT, "test", "diagnostics.test.mts");
		assert.equal(existsSync(path), false, "test/diagnostics.test.mts must be deleted");
	});

	it("no file references config/diagnostics (no dangling import)", () => {
		const hits = readAllSources()
			.map((src, i) => (src.includes("config/diagnostics") ? i : -1))
			.filter((i) => i >= 0);
		assert.equal(hits.length, 0, "no source may import ../config/diagnostics.ts");
	});

	it("no file references detectEventGap / buildErrorNotificationContext", () => {
		const hits = readAllSources()
			.map((src, i) =>
				src.includes("detectEventGap") || src.includes("buildErrorNotificationContext") ? i : -1,
			)
			.filter((i) => i >= 0);
		assert.equal(hits.length, 0, "both exports must die with the module");
	});

	it("config/ retains exactly types.ts, config.ts, merge.ts, workflow.ts", () => {
		const files = readdirSync(join(SUPERVISOR_ROOT, "config"))
			.filter((f) => f.endsWith(".ts"))
			.sort();
		assert.deepEqual(files, ["config.ts", "merge.ts", "types.ts", "workflow.ts"]);
	});
});