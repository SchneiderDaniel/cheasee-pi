/**
 * Tests for session-utils.ts — extracted handleModelChanges() shared function
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-utils.test.mts
 *
 * These tests validate the extracted handleModelChanges function works correctly
 * independent of its consumers (renderer.ts and stats.ts).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { handleModelChanges } from "../session-utils.ts";
import type { ModelChange } from "../session-utils.ts";

// ---------------------------------------------------------------------------
// handleModelChanges() — extracted shared function unit tests
// ---------------------------------------------------------------------------

describe("handleModelChanges — happy path", () => {
	it("empty entries array causes no pushes", () => {
		const entries: any[] = [];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 0);
		assert.strictEqual(thinkingChanges.length, 0);
	});

	it("single model_change entry pushes correct data to modelChanges", () => {
		const entries = [
			{
				type: "model_change",
				timestamp: "2025-01-01T00:00:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
		];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 1);
		assert.strictEqual(thinkingChanges.length, 0);
		assert.deepStrictEqual(modelChanges[0], {
			time: "2025-01-01T00:00:00Z",
			model: "openai/gpt-4",
		});
	});

	it("single thinking_level_change entry pushes correct data to thinkingChanges", () => {
		const entries = [
			{ type: "thinking_level_change", timestamp: "2025-01-01T00:00:00Z", thinkingLevel: "high" },
		];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 0);
		assert.strictEqual(thinkingChanges.length, 1);
		assert.deepStrictEqual(thinkingChanges[0], {
			time: "2025-01-01T00:00:00Z",
			level: "high",
		});
	});

	it("multiple entries interleaved pushes correct counts and preserves order", () => {
		const entries = [
			{ type: "model_change", timestamp: "t1", provider: "openai", modelId: "gpt-4" },
			{ type: "thinking_level_change", timestamp: "t2", thinkingLevel: "high" },
			{ type: "model_change", timestamp: "t3", provider: "anthropic", modelId: "claude-3" },
		];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 2);
		assert.strictEqual(thinkingChanges.length, 1);
		assert.deepStrictEqual(modelChanges[0], { time: "t1", model: "openai/gpt-4" });
		assert.deepStrictEqual(modelChanges[1], { time: "t3", model: "anthropic/claude-3" });
		assert.deepStrictEqual(thinkingChanges[0], { time: "t2", level: "high" });
	});

	it("entries with non-matching types are skipped", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "hello" } },
			{ type: "compaction", timestamp: "t1", tokensBefore: 1000 },
			{ type: "custom", customType: "test", data: {} },
			{ type: "session", id: "s1" },
		];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 0);
		assert.strictEqual(thinkingChanges.length, 0);
	});
});

describe("handleModelChanges — boundary conditions", () => {
	it("entry.timestamp is undefined — time field is undefined", () => {
		const entries = [{ type: "model_change", provider: "openai", modelId: "gpt-4" }];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 1);
		assert.strictEqual(modelChanges[0].time, undefined);
	});

	it("entry.provider or entry.modelId is undefined — model string contains undefined", () => {
		const entries = [
			{ type: "model_change", timestamp: "t1", modelId: "gpt-4" }, // no provider
		];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 1);
		assert.strictEqual(modelChanges[0].model, "undefined/gpt-4");
	});

	it("entry.thinkingLevel is undefined — level field is undefined", () => {
		const entries = [{ type: "thinking_level_change", timestamp: "t1" }];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(thinkingChanges.length, 1);
		assert.strictEqual(thinkingChanges[0].level, undefined);
	});

	it("entry.timestamp is null — time field is null (not coerced to string)", () => {
		const entries = [
			{ type: "model_change", timestamp: null, provider: "openai", modelId: "gpt-4" },
		];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 1);
		assert.strictEqual(modelChanges[0].time, null);
	});
});

describe("handleModelChanges — immutability and side effects", () => {
	it("mutates caller-supplied arrays", () => {
		const entries = [
			{ type: "model_change", timestamp: "t1", provider: "openai", modelId: "gpt-4" },
		];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 1);
		// Arrays are the same reference, mutated in-place
	});

	it("readonly input entries array does not cause runtime error", () => {
		const entries: readonly any[] = [
			{ type: "model_change", timestamp: "t1", provider: "openai", modelId: "gpt-4" },
			{ type: "thinking_level_change", timestamp: "t2", thinkingLevel: "high" },
		];
		const modelChanges: ModelChange[] = [];
		const thinkingChanges: { time: string; level: string }[] = [];

		// Should not throw at runtime despite readonly type
		handleModelChanges(entries, modelChanges, thinkingChanges);

		assert.strictEqual(modelChanges.length, 1);
		assert.strictEqual(thinkingChanges.length, 1);
	});
});

describe("handleModelChanges — type exports", () => {
	it("ModelChange interface has correct shape", () => {
		const change: ModelChange = { time: "t1", model: "openai/gpt-4" };
		assert.strictEqual(change.time, "t1");
		assert.strictEqual(change.model, "openai/gpt-4");
	});

	it("ThinkingChange-shaped object has correct shape", () => {
		const change: { time: string; level: string } = { time: "t1", level: "high" };
		assert.strictEqual(change.time, "t1");
		assert.strictEqual(change.level, "high");
	});
});
