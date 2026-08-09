/**
 * Tests for caveman config.ts
 *
 * Phase 2: Config persistence with closure state.
 * Uses injectable configPath for temp dir isolation.
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfigStore } from "../config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "caveman-test-"));
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config.ts — createConfigStore returns correct API", () => {
	it("returns object with keys: ensureConfigLoaded, getConfig, saveConfig, getLevel, setLevel", () => {
		const store = createConfigStore(join(tmpDir, "caveman.json"));
		assert.ok(typeof store.ensureConfigLoaded === "function");
		assert.ok(typeof store.getConfig === "function");
		assert.ok(typeof store.saveConfig === "function");
		assert.ok(typeof store.getLevel === "function");
		assert.ok(typeof store.setLevel === "function");
	});
});

describe("config.ts — getConfig returns DEFAULT_CONFIG when no file exists", () => {
	it("returns default config on fresh store", async () => {
		const store = createConfigStore(join(tmpDir, "caveman.json"));
		await store.ensureConfigLoaded();
		assert.deepStrictEqual(store.getConfig(), { defaultLevel: "lite", showStatus: true });
	});
});

describe("config.ts — setLevel and getLevel", () => {
	it("setLevel('ultra') then getLevel() returns 'ultra'", () => {
		const store = createConfigStore(join(tmpDir, "caveman.json"));
		store.setLevel("ultra");
		assert.strictEqual(store.getLevel(), "ultra");
	});
});

describe("config.ts — saveConfig writes valid JSON", () => {
	it("saveConfig persists to file readable as CavemanConfig", async () => {
		const configPath = join(tmpDir, "caveman.json");
		const store = createConfigStore(configPath);
		await store.saveConfig({ defaultLevel: "ultra", showStatus: false });

		// Read the file directly
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw);
		assert.strictEqual(parsed.defaultLevel, "ultra");
		assert.strictEqual(parsed.showStatus, false);
	});
});

describe("config.ts — persisted values survive reload", () => {
	it("after saveConfig, new store reads persisted values", async () => {
		const configPath = join(tmpDir, "caveman.json");
		const store1 = createConfigStore(configPath);
		await store1.saveConfig({ defaultLevel: "full", showStatus: false });

		const store2 = createConfigStore(configPath);
		await store2.ensureConfigLoaded();
		assert.strictEqual(store2.getConfig().defaultLevel, "full");
		assert.strictEqual(store2.getConfig().showStatus, false);
	});
});

describe("config.ts — ensureConfigLoaded caches after first call", () => {
	it("second call returns cached result (no re-read)", async () => {
		const configPath = join(tmpDir, "caveman.json");
		writeFileSync(configPath, JSON.stringify({ defaultLevel: "full", showStatus: false }), "utf8");

		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();
		assert.strictEqual(store.getConfig().defaultLevel, "full");

		// Change file behind the scenes
		writeFileSync(configPath, JSON.stringify({ defaultLevel: "ultra", showStatus: true }), "utf8");

		// Second call should return cached (original) value
		await store.ensureConfigLoaded();
		assert.strictEqual(store.getConfig().defaultLevel, "full");
	});
});

describe("config.ts — saveConfig updates in-memory config immediately", () => {
	it("getConfig returns new showStatus right after saveConfig", async () => {
		const store = createConfigStore(join(tmpDir, "caveman.json"));
		await store.saveConfig({ defaultLevel: "ultra", showStatus: false });
		// In-memory must reflect new value before disk write resolves
		assert.strictEqual(store.getConfig().showStatus, false);
		assert.strictEqual(store.getConfig().defaultLevel, "ultra");
	});

	it("subsequent getConfig calls return latest saved config", async () => {
		const store = createConfigStore(join(tmpDir, "caveman.json"));
		await store.saveConfig({ defaultLevel: "full", showStatus: true });
		assert.strictEqual(store.getConfig().defaultLevel, "full");

		// Save again with different values
		await store.saveConfig({ defaultLevel: "ultra", showStatus: false });
		assert.strictEqual(store.getConfig().defaultLevel, "ultra");
		assert.strictEqual(store.getConfig().showStatus, false);
	});
});

describe("config.ts — error paths", () => {
	it("malformed JSON falls back to DEFAULT_CONFIG", async () => {
		const configPath = join(tmpDir, "caveman.json");
		writeFileSync(configPath, "not-json{", "utf8");

		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();
		assert.deepStrictEqual(store.getConfig(), { defaultLevel: "lite", showStatus: true });
	});

	it("invalid defaultLevel falls back to DEFAULT_CONFIG.defaultLevel", async () => {
		const configPath = join(tmpDir, "caveman.json");
		writeFileSync(
			configPath,
			JSON.stringify({ defaultLevel: "invalid", showStatus: true }),
			"utf8",
		);

		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();
		assert.strictEqual(store.getConfig().defaultLevel, "lite");
	});

	it("showStatus as string falls back to DEFAULT_CONFIG.showStatus", async () => {
		const configPath = join(tmpDir, "caveman.json");
		writeFileSync(configPath, JSON.stringify({ defaultLevel: "lite", showStatus: "yes" }), "utf8");

		const store = createConfigStore(configPath);
		await store.ensureConfigLoaded();
		assert.strictEqual(store.getConfig().showStatus, true);
	});

	it("write to unwritable dir fails silently", async () => {
		const configPath = "/dev/null/caveman.json";
		const store = createConfigStore(configPath);
		await store.saveConfig({ defaultLevel: "ultra", showStatus: false });
		// Should not throw
		assert.ok(true);
	});
});
