// Phase 3 — inventory and config fingerprints. These decide whether a resumed
// checkpoint still describes the same audit, so they must be stable across
// ordering and sensitive to every field that changes a verdict.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { configFingerprint, inventoryFingerprint } from "../lib/fingerprint.ts";
import type { TestDefinition, ValidatorConfig } from "../lib/types.ts";

const BASE_CONFIG: ValidatorConfig = {
	provider: "openai",
	model: "gpt-4.1",
	concurrency: 4,
	badConfidenceThreshold: 0.8,
	maxAttempts: 3,
	haltAfterConsecutiveFailures: 5,
};

const CRITERIA_HASH = createHash("sha256").update("criteria body", "utf8").digest("hex");

function def(overrides: Partial<TestDefinition> = {}): TestDefinition {
	return {
		file: "src/a.test.mts",
		name: "outer > keeps total",
		language: "typescript",
		startLine: 10,
		endLine: 14,
		sourceSha256: "a".repeat(64),
		...overrides,
	};
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("fingerprint: inventory identity", () => {
	it("is a lowercase hex sha256", () => {
		assert.match(inventoryFingerprint([def()]), HEX64);
	});

	it("ignores the order the definitions were discovered in", () => {
		const definitions = [
			def({ name: "first", startLine: 1, endLine: 2 }),
			def({ file: "src/b.test.mts", name: "second", startLine: 3, endLine: 4 }),
			def({ name: "third", startLine: 9, endLine: 12 }),
		];

		assert.equal(
			inventoryFingerprint(definitions),
			inventoryFingerprint([...definitions].reverse()),
		);
	});

	it("changes when any identity field changes", () => {
		const baseline = inventoryFingerprint([def()]);

		const variants = [
			def({ name: "outer > keeps total " }),
			def({ startLine: 11 }),
			def({ endLine: 15 }),
			def({ sourceSha256: "b".repeat(64) }),
			def({ language: "go" }),
		];
		for (const variant of variants) {
			assert.notEqual(inventoryFingerprint([variant]), baseline, JSON.stringify(variant));
		}
	});

	it("changes when a definition is added or removed", () => {
		const one = [def()];
		const two = [def(), def({ name: "second", startLine: 20, endLine: 22 })];

		assert.notEqual(inventoryFingerprint(one), inventoryFingerprint(two));
		assert.notEqual(inventoryFingerprint(two), inventoryFingerprint([two[1]]));
	});

	it("distinguishes definitions that only differ by file", () => {
		assert.notEqual(
			inventoryFingerprint([def({ file: "src/a.test.mts" })]),
			inventoryFingerprint([def({ file: "src/b.test.mts" })]),
		);
	});

	it("is empty-inventory stable", () => {
		assert.match(inventoryFingerprint([]), HEX64);
		assert.equal(inventoryFingerprint([]), inventoryFingerprint([]));
	});
});

describe("fingerprint: model configuration", () => {
	it("is a lowercase hex sha256", () => {
		assert.match(configFingerprint(BASE_CONFIG, CRITERIA_HASH), HEX64);
	});

	it("changes with provider, model, threshold, or criteria hash", () => {
		const baseline = configFingerprint(BASE_CONFIG, CRITERIA_HASH);

		assert.notEqual(
			configFingerprint({ ...BASE_CONFIG, provider: "anthropic" }, CRITERIA_HASH),
			baseline,
		);
		assert.notEqual(
			configFingerprint({ ...BASE_CONFIG, model: "gpt-4.1-mini" }, CRITERIA_HASH),
			baseline,
		);
		assert.notEqual(
			configFingerprint({ ...BASE_CONFIG, badConfidenceThreshold: 0.9 }, CRITERIA_HASH),
			baseline,
		);
		assert.notEqual(configFingerprint(BASE_CONFIG, "c".repeat(64)), baseline);
	});

	it("ignores knobs that cannot change a verdict", () => {
		const baseline = configFingerprint(BASE_CONFIG, CRITERIA_HASH);

		assert.equal(
			configFingerprint(
				{ ...BASE_CONFIG, concurrency: 1, maxAttempts: 7, haltAfterConsecutiveFailures: 1 },
				CRITERIA_HASH,
			),
			baseline,
		);
	});

	it("is deterministic", () => {
		assert.equal(
			configFingerprint(BASE_CONFIG, CRITERIA_HASH),
			configFingerprint(BASE_CONFIG, CRITERIA_HASH),
		);
	});
});
