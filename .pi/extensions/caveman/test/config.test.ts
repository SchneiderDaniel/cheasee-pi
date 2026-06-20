/**
 * Phase 1: Config store adapter — ensureConfigLoaded contract
 *
 * Verifies config.ts no longer sets currentLevel during load.
 * Session-policy decisions moved to use-case layer (lib/extension-state.ts).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, unlink, rmdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfigStore } from "../config.ts";
import type { Level } from "../types.ts";
import { LEVELS } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function randomDir(): string {
	return join(tmpdir(), `caveman-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

async function writeConfig(data: unknown): Promise<string> {
	const dir = randomDir();
	await mkdir(dir, { recursive: true });
	const path = join(dir, "caveman.json");
	await writeFile(path, JSON.stringify(data));
	return path;
}

async function cleanDir(dir: string): Promise<void> {
	try {
		await unlink(join(dir, "caveman.json"));
	} catch {
		/* ignore */
	}
	try {
		await rmdir(dir);
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfigStore adapter", () => {
	describe("ensureConfigLoaded", () => {
		it("parses valid config file and returns values via getConfig()", async () => {
			const path = await writeConfig({ defaultLevel: "ultra", showStatus: false });
			const store = createConfigStore(path);
			await store.ensureConfigLoaded();
			assert.equal(store.getConfig().defaultLevel, "ultra");
			assert.equal(store.getConfig().showStatus, false);
			await cleanDir(join(path, ".."));
		});

		it("falls back to DEFAULT_CONFIG when file is missing", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "nonexistent.json");
			const store = createConfigStore(path);
			await store.ensureConfigLoaded();
			assert.equal(store.getConfig().defaultLevel, "lite"); // DEFAULT_CONFIG
			assert.equal(store.getConfig().showStatus, true);
			await cleanDir(dir);
		});

		it("falls back to DEFAULT_CONFIG when file contains invalid JSON", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "caveman.json");
			await writeFile(path, "not-json{{{");
			const store = createConfigStore(path);
			await store.ensureConfigLoaded();
			assert.equal(store.getConfig().defaultLevel, "lite");
			await cleanDir(dir);
		});

		it("falls back to DEFAULT_CONFIG.defaultLevel when file has invalid defaultLevel string", async () => {
			const path = await writeConfig({ defaultLevel: "invalid", showStatus: false });
			const store = createConfigStore(path);
			await store.ensureConfigLoaded();
			assert.equal(store.getConfig().defaultLevel, "lite"); // DEFAULT_CONFIG
			await cleanDir(join(path, ".."));
		});

		it("does NOT mutate currentLevel when defaultLevel=off (no session-policy leak)", async () => {
			const path = await writeConfig({ defaultLevel: "off", showStatus: true });
			const store = createConfigStore(path);
			assert.equal(store.getLevel(), "off"); // initial
			await store.ensureConfigLoaded();
			// After fix: ensureConfigLoaded should NOT set currentLevel
			assert.equal(store.getLevel(), "off");
			await cleanDir(join(path, ".."));
		});

		it("does NOT seed currentLevel when defaultLevel=lite (config loader no longer seeds)", async () => {
			const path = await writeConfig({ defaultLevel: "lite", showStatus: true });
			const store = createConfigStore(path);
			assert.equal(store.getLevel(), "off"); // initial
			await store.ensureConfigLoaded();
			// After fix: config loader should not seed currentLevel
			assert.equal(store.getLevel(), "off");
			await cleanDir(join(path, ".."));
		});
	});

	describe("getLevel / setLevel round-trip", () => {
		it("round-trips all 4 levels", async () => {
			const path = await writeConfig(DEFAULT_CONFIG);
			const store = createConfigStore(path);
			for (const level of LEVELS) {
				store.setLevel(level);
				assert.equal(store.getLevel(), level, `round-trip failed for ${level}`);
			}
			await cleanDir(join(path, ".."));
		});
	});

	describe("saveConfig", () => {
		it("writes correct JSON to disk and subsequent ensureConfigLoaded reads it back", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "caveman.json");
			const store = createConfigStore(path);
			await store.saveConfig({ defaultLevel: "ultra", showStatus: false });

			// New store instance reads what was saved
			const store2 = createConfigStore(path);
			await store2.ensureConfigLoaded();
			assert.equal(store2.getConfig().defaultLevel, "ultra");
			assert.equal(store2.getConfig().showStatus, false);
			await cleanDir(dir);
		});
	});

	describe("saveConfig error handling & resilience", () => {
		it("logs an error when write fails (path is a directory)", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });

			// Use the directory itself as the config path — writeFile will fail
			const store = createConfigStore(dir);

			const logs: any[][] = [];
			const origError = console.error;
			console.error = (...args: any[]) => {
				logs.push(args);
			};

			try {
				await store.saveConfig({ defaultLevel: "lite", showStatus: true });
				assert.ok(logs.length > 0, "console.error should be called when file write fails");
				const joined = logs.map((a) => a.join(" ")).join("\n");
				assert.ok(
					joined.includes("Failed to save"),
					`error message should mention "Failed to save", got: ${joined.slice(0, 200)}`,
				);
			} finally {
				console.error = origError;
				await cleanDir(dir);
			}
		});

		it("does not stall saveQueue when JSON.stringify throws (circular reference in object)", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "caveman.json");
			const store = createConfigStore(path);

			// Create an object that throws during JSON.stringify
			const circular: Record<string, unknown> = {
				defaultLevel: "lite",
				showStatus: true,
			};
			circular.self = circular;

			// First save should fail (circular), but must not stall the queue
			await store.saveConfig(circular as any);

			// Subsequent save must still work
			await store.saveConfig({ defaultLevel: "ultra", showStatus: false });

			// New store instance should read the second (valid) config
			const store2 = createConfigStore(path);
			await store2.ensureConfigLoaded();
			assert.equal(store2.getConfig().defaultLevel, "ultra");
			assert.equal(store2.getConfig().showStatus, false);

			await cleanDir(dir);
		});

		it("rapid consecutive saves preserve ordering (last write wins)", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "caveman.json");
			const store = createConfigStore(path);

			// Fire two saves without awaiting between them
			const p1 = store.saveConfig({ defaultLevel: "lite", showStatus: true });
			const p2 = store.saveConfig({ defaultLevel: "ultra", showStatus: false });
			await Promise.all([p1, p2]);

			// Last config should be on disk
			const store2 = createConfigStore(path);
			await store2.ensureConfigLoaded();
			assert.equal(store2.getConfig().defaultLevel, "ultra");
			assert.equal(store2.getConfig().showStatus, false);

			await cleanDir(dir);
		});

		it("returns promise that resolves after file write completes", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "caveman.json");
			const store = createConfigStore(path);

			await store.saveConfig({ defaultLevel: "ultra", showStatus: false });

			// After await, the file must exist with correct content
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw);
			assert.equal(parsed.defaultLevel, "ultra");
			assert.equal(parsed.showStatus, false);

			await cleanDir(dir);
		});

		it("updates in-memory config synchronously before file write begins (existing behavior preserved)", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "caveman.json");
			const store = createConfigStore(path);

			// Call saveConfig but do NOT await — in-memory should update immediately
			const promise = store.saveConfig({ defaultLevel: "ultra", showStatus: false });

			assert.equal(
				store.getConfig().defaultLevel,
				"ultra",
				"in-memory defaultLevel should update synchronously",
			);
			assert.equal(
				store.getConfig().showStatus,
				false,
				"in-memory showStatus should update synchronously",
			);

			await promise;
			await cleanDir(dir);
		});
	});
});

const DEFAULT_CONFIG = { defaultLevel: "lite" as const, showStatus: true as const };
