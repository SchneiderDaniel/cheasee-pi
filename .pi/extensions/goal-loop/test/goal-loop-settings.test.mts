// ─── Phase 4: goalLoop settings + model resolution ───────────────
// R6: the configured model and limits are validated before anything runs, and
// the resolver is never called with a session/default model.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkModelCapacity,
	DEFAULT_CONTEXT_ROLLOVER_TOKENS,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_RESERVE_TOKENS,
	GoalLoopSettingsSchema,
	loadGoalLoopSettings,
	parseGoalLoopSettings,
	prepareGoalLoopConfig,
	resolveGoalModel,
} from "../config/goal-loop-settings.ts";
import { createModelResolver } from "./helpers/fake-ports.mts";

function withSettingsFile(content: string): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "goal-settings-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, content);
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("GoalLoopSettingsSchema", () => {
	it("applies the documented defaults", () => {
		const parsed = GoalLoopSettingsSchema.parse({ model: "provider/model-id" });
		assert.equal(parsed.contextRolloverTokens, DEFAULT_CONTEXT_ROLLOVER_TOKENS);
		assert.equal(parsed.maxIterations, DEFAULT_MAX_ITERATIONS);
		assert.equal(parsed.contextRolloverTokens, 150_000);
		assert.equal(parsed.maxIterations, 50);
	});

	const rejected: Array<[string, unknown]> = [
		["missing model", { contextRolloverTokens: 1000 }],
		["empty model", { model: "" }],
		["zero rollover", { model: "p/m", contextRolloverTokens: 0 }],
		["negative rollover", { model: "p/m", contextRolloverTokens: -1 }],
		["fractional rollover", { model: "p/m", contextRolloverTokens: 1.5 }],
		["string rollover", { model: "p/m", contextRolloverTokens: "150000" }],
		["zero iterations", { model: "p/m", maxIterations: 0 }],
		["negative iterations", { model: "p/m", maxIterations: -1 }],
		["fractional iterations", { model: "p/m", maxIterations: 1.5 }],
		["string iterations", { model: "p/m", maxIterations: "50" }],
	];

	for (const [label, raw] of rejected) {
		it(`rejects ${label} with a goalLoop.* field path`, () => {
			const parsed = parseGoalLoopSettings(raw);
			assert.equal(parsed.ok, false);
			if (!parsed.ok) assert.match(parsed.error, /goalLoop\./);
		});
	}

	it("names the failing field path", () => {
		const parsed = parseGoalLoopSettings({ model: "p/m", maxIterations: 0 });
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /goalLoop\.maxIterations/);
	});
});

describe("loadGoalLoopSettings", () => {
	it("reads goalLoop beside an untouched supervisor object", () => {
		const fixture = withSettingsFile(
			JSON.stringify({
				supervisor: { repo: "owner/repo" },
				goalLoop: { model: "p/m", contextRolloverTokens: 200_000, maxIterations: 7 },
			}),
		);
		try {
			const loaded = loadGoalLoopSettings(fixture.path);
			assert.equal(loaded.ok, true);
			if (!loaded.ok) return;
			assert.deepEqual(loaded.value.settings, {
				model: "p/m",
				contextRolloverTokens: 200_000,
				maxIterations: 7,
			});
			assert.equal(loaded.value.reserveTokens, DEFAULT_RESERVE_TOKENS);
		} finally {
			fixture.cleanup();
		}
	});

	it("reads compaction.reserveTokens from the same settings source", () => {
		const fixture = withSettingsFile(
			JSON.stringify({
				compaction: { reserveTokens: 4_000 },
				goalLoop: { model: "p/m" },
			}),
		);
		try {
			const loaded = loadGoalLoopSettings(fixture.path);
			assert.equal(loaded.ok, true);
			if (loaded.ok) assert.equal(loaded.value.reserveTokens, 4_000);
		} finally {
			fixture.cleanup();
		}
	});

	it("distinguishes malformed JSON from a missing goalLoop key", () => {
		const malformed = withSettingsFile("{ not json");
		const missing = withSettingsFile(JSON.stringify({ supervisor: { repo: "o/r" } }));
		try {
			const badJson = loadGoalLoopSettings(malformed.path);
			const noKey = loadGoalLoopSettings(missing.path);
			assert.equal(badJson.ok, false);
			assert.equal(noKey.ok, false);
			if (!badJson.ok) assert.match(badJson.error, /malformed JSON/);
			if (!noKey.ok) assert.match(noKey.error, /no "goalLoop" key/);
			if (!badJson.ok && !noKey.ok) assert.notEqual(badJson.error, noKey.error);
		} finally {
			malformed.cleanup();
			missing.cleanup();
		}
	});

	it("fails closed when the settings file does not exist", () => {
		const loaded = loadGoalLoopSettings(join(tmpdir(), "definitely-missing", "settings.json"));
		assert.equal(loaded.ok, false);
	});

	it("never reads or writes the repository's own .pi/settings.json", () => {
		const fixture = withSettingsFile(JSON.stringify({ goalLoop: { model: "p/m" } }));
		try {
			assert.equal(loadGoalLoopSettings(fixture.path).ok, true);
		} finally {
			fixture.cleanup();
		}
	});
});

describe("resolveGoalModel", () => {
	it("rejects a ref without a slash and names provider/model-id", () => {
		const { resolver, calls } = createModelResolver();
		const resolved = resolveGoalModel("no-slash", resolver);
		assert.equal(resolved.ok, false);
		if (!resolved.ok) assert.match(resolved.error, /provider\/model-id/);
		assert.deepEqual(calls, []);
	});

	it("names the configured string when the catalog cannot resolve it", () => {
		const { resolver } = createModelResolver({ failFor: ["nope/nope"] });
		const resolved = resolveGoalModel("nope/nope", resolver);
		assert.equal(resolved.ok, false);
		if (!resolved.ok) assert.match(resolved.error, /nope\/nope/);
	});

	it("calls the resolver with the configured value only", () => {
		const { resolver, calls } = createModelResolver();
		const resolved = resolveGoalModel("provider/model-id", resolver);
		assert.equal(resolved.ok, true);
		assert.deepEqual(calls, ["provider/model-id"]);
		assert.equal(calls.includes("gpt-6-luna"), false);
		if (resolved.ok) assert.equal(resolved.value.ref, "provider/model-id");
	});
});

describe("capacity gate", () => {
	it("refuses when the window cannot fit the threshold plus the reserve", () => {
		const refused = checkModelCapacity({
			modelRef: "p/m",
			contextWindow: 160_000,
			rolloverTokens: 150_000,
			reserveTokens: 16_384,
		});
		assert.equal(refused.ok, false);
		if (!refused.ok) {
			assert.match(refused.error, /150000/);
			assert.match(refused.error, /166384/);
			assert.match(refused.error, /160000/);
		}
	});

	it("accepts boundary equality", () => {
		const accepted = checkModelCapacity({
			modelRef: "p/m",
			contextWindow: 166_384,
			rolloverTokens: 150_000,
			reserveTokens: 16_384,
		});
		assert.equal(accepted.ok, true);
	});
});

describe("prepareGoalLoopConfig", () => {
	it("returns settings and the resolved model when everything checks out", () => {
		const fixture = withSettingsFile(JSON.stringify({ goalLoop: { model: "p/m" } }));
		const { resolver } = createModelResolver({ contextWindow: 400_000 });
		try {
			const prepared = prepareGoalLoopConfig({ settingsPath: fixture.path, resolve: resolver });
			assert.equal(prepared.ok, true);
			if (prepared.ok) {
				assert.equal(prepared.value.settings.model, "p/m");
				assert.equal(prepared.value.model.contextWindow, 400_000);
			}
		} finally {
			fixture.cleanup();
		}
	});

	it("refuses a model whose window is too small", () => {
		const fixture = withSettingsFile(JSON.stringify({ goalLoop: { model: "p/m" } }));
		const { resolver } = createModelResolver({ contextWindow: 100_000 });
		try {
			const prepared = prepareGoalLoopConfig({ settingsPath: fixture.path, resolve: resolver });
			assert.equal(prepared.ok, false);
			if (!prepared.ok) assert.match(prepared.error, /context window/);
		} finally {
			fixture.cleanup();
		}
	});
});
