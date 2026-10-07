/**
 * Verification test for dead code removal — Issue #1872.
 *
 * Confirms that the module-private `ProjectHarnessConfig` interface has been
 * removed from `lib/load-config.ts`. The interface was declared but never
 * referenced: the loader parses JSON into `Record<string, unknown>` and
 * validates at runtime, so the type documented a contract that was not
 * enforced (and was inaccurate for partial `toolMeta` overrides).
 *
 * The removed symbol is NOT statically imported here — the source is read as
 * text and the surviving public contract is verified via dynamic import().
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/agent-harness/test/dead-code-removal.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const sourcePath = resolve(import.meta.dirname, "../lib/load-config.ts");

describe("dead code removal — Issue #1872 (unused ProjectHarnessConfig)", () => {
	it("no longer declares or references ProjectHarnessConfig", () => {
		const content = readFileSync(sourcePath, "utf-8");
		const matches = content.match(/ProjectHarnessConfig/g) ?? [];
		assert.equal(
			matches.length,
			0,
			`Expected zero occurrences of ProjectHarnessConfig, found ${matches.length}`,
		);
	});

	it("does not re-add the misleading interface shape", () => {
		const content = readFileSync(sourcePath, "utf-8");
		assert.ok(
			!content.includes("interface ProjectHarnessConfig"),
			"interface ProjectHarnessConfig declaration must be absent",
		);
		assert.ok(
			!content.includes("toolMeta?: Record<string, ToolMeta>"),
			"misleading 'toolMeta?: Record<string, ToolMeta>' body must be absent",
		);
	});

	it("public contract intact after deletion: loadProjectConfig, ALLOWED_CONFIG_KEYS, loadDefaultRules", async () => {
		const mod = await import("../lib/load-config.ts");
		assert.equal(typeof mod.loadProjectConfig, "function", "loadProjectConfig must remain callable");
		assert.ok(mod.ALLOWED_CONFIG_KEYS instanceof Set, "ALLOWED_CONFIG_KEYS must remain a Set");
		assert.equal(typeof mod.loadDefaultRules, "function", "loadDefaultRules must remain callable");

		// Call both to prove they are live, using an empty temp dir (no config file)
		// so the loader returns defaults without touching the real project.
		const dir = mkdtempSync(resolve(tmpdir(), "harness-dead-code-"));
		try {
			const rules = mod.loadProjectConfig({ isProjectTrusted: () => false }, dir);
			assert.equal(rules.cascadeThreshold, mod.loadDefaultRules().cascadeThreshold);
			assert.deepEqual(rules.toolMeta, mod.loadDefaultRules().toolMeta);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
