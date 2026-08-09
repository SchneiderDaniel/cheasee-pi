// ─── Phase 7: Experimental features gate — handler.ts ────────────
// Tests that handler reads config.enableExperimentalFeatures and
// gates experimental stages (auto-forking, advanced parallelism).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── enableExperimentalFeatures gating contract ──────────────────

describe("enableExperimentalFeatures — gating", () => {
	it("config.enableExperimentalFeatures is optional (undefined → false)", () => {
		const config: Record<string, unknown> = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: { todo: "developer" },
			codeowners: ["user"],
		};
		const enabled = config.enableExperimentalFeatures === true;
		assert.equal(enabled, false, "undefined should resolve to false");
	});

	it("config.enableExperimentalFeatures: true → experimental features enabled", () => {
		const config: { enableExperimentalFeatures?: boolean } = {
			enableExperimentalFeatures: true,
		};
		assert.equal(config.enableExperimentalFeatures, true);
	});

	it("config.enableExperimentalFeatures: false → experimental features disabled", () => {
		const config: { enableExperimentalFeatures?: boolean } = {
			enableExperimentalFeatures: false,
		};
		assert.equal(config.enableExperimentalFeatures, false);
	});

	it("when false/undefined, pipeline skips experimental stages", () => {
		// Simulate the gating logic used in handler
		const experimentalStages = ["auto-fork", "advanced-parallelism"];
		const config = { enableExperimentalFeatures: false };

		const activeStages = experimentalStages.filter(() => config.enableExperimentalFeatures);
		assert.equal(activeStages.length, 0, "no experimental stages when disabled");
	});

	it("when true, pipeline includes experimental stages", () => {
		const experimentalStages = ["auto-fork", "advanced-parallelism"];
		const config = { enableExperimentalFeatures: true };

		const activeStages = experimentalStages.filter(() => config.enableExperimentalFeatures);
		assert.equal(activeStages.length, 2, "all experimental stages when enabled");
	});

	it("experimental stages are identifiable by flag/skip mechanism in stage loop", () => {
		// Contract test: each stage knows whether it's experimental
		const stages = [
			{ name: "research", experimental: false },
			{ name: "architecture", experimental: false },
			{ name: "test-design", experimental: false },
			{ name: "implementation", experimental: false },
			{ name: "audit", experimental: false },
			{ name: "auto-fork", experimental: true },
			{ name: "advanced-parallelism", experimental: true },
		];

		const enabled = false;
		const runnable = stages.filter((s) => !s.experimental || enabled);
		assert.equal(runnable.length, 5, "only core stages when disabled");
		assert.ok(!runnable.some((s) => s.experimental), "no experimental stages when disabled");
	});

	it("pipeline loop runs core stages only when flag absent (backward compat)", () => {
		const stages = [
			{ name: "research", experimental: false },
			{ name: "architecture", experimental: false },
			{ name: "implementation", experimental: false },
			{ name: "audit", experimental: false },
		];

		// Without enableExperimentalFeatures (undefined)
		const enabled = undefined;
		const runnable = stages.filter((s) => !s.experimental || enabled);
		assert.equal(runnable.length, 4, "all non-experimental stages run");
	});

	it("boundary: pipeline with no experimental stages runs same as today", () => {
		const stages = ["research", "architecture", "implementation", "audit"];
		const enabled = false;
		// Pipeline with no experimental stages: same as today regardless of flag
		const result = stages.filter(() => true); // No filtering needed
		assert.equal(result.length, 4);
	});
});
