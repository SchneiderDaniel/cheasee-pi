/**
 * Tests for load-config.ts — project-local harness config loader with trust gate.
 *
 * Uses temp files for filesystem operations, cleaned up in after/finally.
 * Mock ctx objects for trust and UI notification assertions.
 *
 * @packageDocumentation
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadProjectConfig, loadDefaultRules } from "./load-config.ts";
import type { ResolvedHarnessRules } from "./harness-rules.ts";

// ── Helpers ──

let tempDirs: string[] = [];

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-config-test-"));
	tempDirs.push(dir);
	// Create .pi subdirectory
	fs.mkdirSync(path.join(dir, ".pi"));
	return dir;
}

function writeConfig(dir: string, content: unknown): string {
	const configPath = path.join(dir, ".pi", "harness-config.json");
	fs.writeFileSync(configPath, JSON.stringify(content), "utf-8");
	return configPath;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		isProjectTrusted: () => true,
		ui: {
			notify: () => {},
		},
		...overrides,
	};
}

after(() => {
	// Clean up temp dirs
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

// ── Tests ──

describe("loadProjectConfig", () => {
	it("Config file missing → returns defaults, no file read attempt", () => {
		const dir = createTempDir();
		// No config file written
		const rules = loadProjectConfig(makeCtx(), dir);
		const defaults = loadDefaultRules();
		assert.equal(rules.cascadeThreshold, defaults.cascadeThreshold);
		assert.deepEqual(rules.toolMeta, defaults.toolMeta);
	});

	it("Config file exists, isProjectTrusted() returns true → loads, shallow-merges toolMeta overrides, applies cascadeThreshold override", () => {
		const dir = createTempDir();
		writeConfig(dir, {
			toolMeta: { bash: { cascadeThreshold: 12 } },
			cascadeThreshold: 10,
		});
		const rules = loadProjectConfig(makeCtx(), dir);
		assert.equal(rules.cascadeThreshold, 10);
		assert.equal(rules.toolMeta.bash?.cascadeThreshold, 12);
		// Other tools unchanged
		assert.equal(rules.toolMeta.web_crawl?.cascadeThreshold, 20);
		assert.equal(rules.toolMeta.ask_user?.passThrough, true);
	});

	it("Config file exists, isProjectTrusted() returns false → skips file, calls ctx.ui.notify() with warning, returns defaults", () => {
		const dir = createTempDir();
		writeConfig(dir, { cascadeThreshold: 99 });
		let notifyCalled = false;
		let notifyMessage = "";
		const ctx = makeCtx({
			isProjectTrusted: () => false,
			ui: {
				notify: (msg: string) => {
					notifyCalled = true;
					notifyMessage = msg;
				},
			},
		});
		const rules = loadProjectConfig(ctx, dir);
		assert.equal(notifyCalled, true);
		assert.ok(notifyMessage.includes("not trusted"));
		assert.equal(rules.cascadeThreshold, 8); // default
	});

	it("Config file exists, trusted, partial toolMeta override ({ bash: { cascadeThreshold: 12 } }) → merged: bash threshold 12, other tools unchanged", () => {
		const dir = createTempDir();
		writeConfig(dir, { toolMeta: { bash: { cascadeThreshold: 12 } } });
		const rules = loadProjectConfig(makeCtx(), dir);
		assert.equal(rules.toolMeta.bash?.cascadeThreshold, 12);
		assert.equal(rules.toolMeta.web_crawl?.cascadeThreshold, 20);
		assert.equal(rules.toolMeta.ask_user?.passThrough, true);
	});

	it("Config file exists, trusted, cascadeThreshold override set → applied", () => {
		const dir = createTempDir();
		writeConfig(dir, { cascadeThreshold: 15 });
		const rules = loadProjectConfig(makeCtx(), dir);
		assert.equal(rules.cascadeThreshold, 15);
	});

	it("Config file exists but malformed JSON → throws with clear parse error message", () => {
		const dir = createTempDir();
		const configPath = path.join(dir, ".pi", "harness-config.json");
		fs.writeFileSync(configPath, "not valid json{", "utf-8");
		assert.throws(() => loadProjectConfig(makeCtx(), dir), /parse/i);
	});

	it("Config file exists, trusted, unknown keys present → throws with 'unknown key' error", () => {
		const dir = createTempDir();
		writeConfig(dir, { unknownKey: true });
		assert.throws(() => loadProjectConfig(makeCtx(), dir), /unknown key/i);
	});

	it("isProjectTrusted() throws → error propagates (fail-closed)", () => {
		const dir = createTempDir();
		writeConfig(dir, { cascadeThreshold: 5 });
		const ctx = makeCtx({
			isProjectTrusted: () => {
				throw new Error("trust check failed");
			},
		});
		assert.throws(() => loadProjectConfig(ctx, dir), /trust check failed/);
	});

	it("Config file exists, trusted, empty object {} → returns defaults unchanged", () => {
		const dir = createTempDir();
		writeConfig(dir, {});
		const rules = loadProjectConfig(makeCtx(), dir);
		const defaults = loadDefaultRules();
		assert.deepEqual(rules, defaults);
	});

	it("getDefaultRules() called directly returns same shape as defaults (verifies factory not mutated by config load)", () => {
		const dir = createTempDir();
		writeConfig(dir, { cascadeThreshold: 99, toolMeta: { bash: { cascadeThreshold: 50 } } });
		const before = loadDefaultRules();
		loadProjectConfig(makeCtx(), dir);
		const after = loadDefaultRules();
		assert.equal(before.cascadeThreshold, after.cascadeThreshold);
		assert.equal(before.cascadeThreshold, 8);
		assert.deepEqual(before.toolMeta, after.toolMeta);
	});
});
