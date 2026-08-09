/**
 * Export-boundary tests for config.ts
 *
 * Verifies that only intended symbols are exported from the config module.
 * Uses dynamic import() to verify removed exports without static imports.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/config-exports.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

interface ThresholdEntry {
	maxTokens: number | null;
}

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
	showTps: boolean;
	showCache: boolean;
	welcomeTimeoutMs: number;
}

const THRESHOLD_VALUES = [{ maxTokens: 100_000 }, { maxTokens: 150_000 }, { maxTokens: null }];

describe("config.ts module boundary", () => {
	it("exports loadConfig as a function", async () => {
		const mod = await import("../config.ts");
		assert.strictEqual(typeof mod.loadConfig, "function");
	});

	it("exports readPiSetting as a function", async () => {
		const mod = await import("../config.ts");
		assert.strictEqual(typeof mod.readPiSetting, "function");
	});

	it("does NOT export DEFAULT_THRESHOLDS", async () => {
		const mod = await import("../config.ts");
		assert.strictEqual(
			(mod as Record<string, unknown>).DEFAULT_THRESHOLDS,
			undefined,
			"DEFAULT_THRESHOLDS should not be exported",
		);
	});

	it("does NOT export DEFAULT_WELCOME_TIMEOUT_MS", async () => {
		const mod = await import("../config.ts");
		assert.strictEqual(
			(mod as Record<string, unknown>).DEFAULT_WELCOME_TIMEOUT_MS,
			undefined,
			"DEFAULT_WELCOME_TIMEOUT_MS should not be exported",
		);
	});
});

describe("ContextStatusBarConfigSchema", () => {
	it("exports ContextStatusBarConfigSchema", async () => {
		const mod = await import("../config.ts");
		assert.ok(
			mod.ContextStatusBarConfigSchema &&
				typeof mod.ContextStatusBarConfigSchema === "object" &&
				"parse" in mod.ContextStatusBarConfigSchema &&
				"safeParse" in mod.ContextStatusBarConfigSchema,
			"ContextStatusBarConfigSchema should be a zod schema with parse/safeParse",
		);
	});

	it("parses empty object with all defaults", async () => {
		const mod = await import("../config.ts");
		const result = mod.ContextStatusBarConfigSchema.safeParse({});
		assert.ok(result.success, "empty object should parse successfully");
		assert.strictEqual(result.data.enabled, true);
		assert.strictEqual(result.data.showTimer, true);
		assert.strictEqual(result.data.showTps, true);
		assert.strictEqual(result.data.showCache, true);
		assert.strictEqual(result.data.welcomeTimeoutMs, 0);
	});

	it("accepts boolean values for boolean fields", async () => {
		const mod = await import("../config.ts");
		const result = mod.ContextStatusBarConfigSchema.safeParse({
			enabled: false,
			showTimer: false,
		});
		assert.ok(result.success);
		assert.strictEqual(result.data.enabled, false);
		assert.strictEqual(result.data.showTimer, false);
		assert.strictEqual(result.data.showTps, true); // default
	});

	it("rejects non-boolean for boolean fields", async () => {
		const mod = await import("../config.ts");
		const result = mod.ContextStatusBarConfigSchema.safeParse({ enabled: "yes" });
		assert.ok(!result.success, "string should not be accepted for boolean field");
	});

	it("accepts finite number for welcomeTimeoutMs", async () => {
		const mod = await import("../config.ts");
		const result = mod.ContextStatusBarConfigSchema.safeParse({ welcomeTimeoutMs: 5000 });
		assert.ok(result.success);
		assert.strictEqual(result.data.welcomeTimeoutMs, 5000);
	});

	it("rejects Infinity for welcomeTimeoutMs", async () => {
		const mod = await import("../config.ts");
		const result = mod.ContextStatusBarConfigSchema.safeParse({ welcomeTimeoutMs: Infinity });
		assert.ok(!result.success, "Infinity should be rejected");
	});

	it("rejects NaN for welcomeTimeoutMs", async () => {
		const mod = await import("../config.ts");
		const result = mod.ContextStatusBarConfigSchema.safeParse({ welcomeTimeoutMs: NaN });
		assert.ok(!result.success, "NaN should be rejected");
	});

	it("strips unknown fields", async () => {
		const mod = await import("../config.ts");
		const result = mod.ContextStatusBarConfigSchema.safeParse({
			enabled: true,
			extraField: "should be stripped",
		});
		assert.ok(result.success);
		assert.strictEqual((result.data as Record<string, unknown>).extraField, undefined);
	});

	it("does NOT include thresholds in schema", async () => {
		const mod = await import("../config.ts");
		const result = mod.ContextStatusBarConfigSchema.safeParse({
			thresholds: [{ maxTokens: 999 }],
		});
		assert.ok(result.success);
		assert.strictEqual((result.data as Record<string, unknown>).thresholds, undefined);
	});
});

describe("loadConfig() default fallback", () => {
	it("returns threshold array matching DEFAULT_THRESHOLDS when settings have no thresholds", async () => {
		const mod = await import("../config.ts");
		const config = mod.loadConfig() as ContextStatusBarConfig | null;
		assert.ok(config !== null, "loadConfig() should not return null");
		assert.ok(Array.isArray(config.thresholds), "thresholds should be an array");
		assert.strictEqual(config.thresholds.length, THRESHOLD_VALUES.length);
		for (let i = 0; i < THRESHOLD_VALUES.length; i++) {
			assert.deepStrictEqual(config.thresholds[i], THRESHOLD_VALUES[i]);
		}
	});

	it("returns welcomeTimeoutMs: 0 when settings have no welcomeTimeoutMs", async () => {
		const mod = await import("../config.ts");
		const config = mod.loadConfig() as ContextStatusBarConfig | null;
		assert.ok(config !== null, "loadConfig() should not return null");
		assert.strictEqual(config.welcomeTimeoutMs, 0);
	});
});
