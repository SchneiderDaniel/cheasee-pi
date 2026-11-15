/**
 * tool-meta.ts — metadata precedence and fail-open policy (entity layer).
 *
 * Issue #2093: the tool-info port is injected at construction, so the lookup
 * takes a non-optional provider. `resetWarning()` was the setter's re-arm hook
 * and is gone — the warning flag now lives for the lookup's whole lifetime.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/agent-harness/lib/tool-meta.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createToolMetaLookup } from "./tool-meta.ts";
import { DESTRUCTIVE_CASCADE_THRESHOLD } from "./harness-rules.ts";
import type { ResolvedHarnessRules } from "./harness-rules.ts";

function rules(overrides: Partial<ResolvedHarnessRules> = {}): ResolvedHarnessRules {
	return { toolMeta: {}, cascadeThreshold: 8, ...overrides };
}

describe("createToolMetaLookup — precedence (entity)", () => {
	it("empty provider yields the generic default for an unconfigured tool", () => {
		const lookup = createToolMetaLookup({ rules: () => rules(), provider: () => () => [] });
		assert.deepEqual(lookup.get("write"), {
			passThrough: false,
			trackErrors: true,
			cascadeThreshold: 8,
		});
	});

	it("read-only annotation disables error tracking", () => {
		const lookup = createToolMetaLookup({
			rules: () => rules(),
			provider: () => () => [{ name: "read", annotations: { readOnlyHint: true } }],
		});
		assert.equal(lookup.get("read").trackErrors, false);
	});

	it("destructive annotation tightens the configured threshold to the destructive default", () => {
		const lookup = createToolMetaLookup({
			rules: () => rules({ cascadeThreshold: 8 }),
			provider: () => () => [{ name: "danger", annotations: { destructiveHint: true } }],
		});
		assert.equal(lookup.get("danger").cascadeThreshold, DESTRUCTIVE_CASCADE_THRESHOLD);
		assert.equal(DESTRUCTIVE_CASCADE_THRESHOLD, 4, "destructive default is 4");
	});

	it("provider tool without annotations falls back to the generic default", () => {
		const lookup = createToolMetaLookup({
			rules: () => rules(),
			provider: () => () => [{ name: "other" }],
		});
		assert.deepEqual(lookup.get("write"), {
			passThrough: false,
			trackErrors: true,
			cascadeThreshold: 8,
		});
	});

	it("explicit toolMeta wins and the provider is never consulted", () => {
		let consulted = 0;
		const lookup = createToolMetaLookup({
			rules: () => rules({ toolMeta: { write: { cascadeThreshold: 3, trackErrors: false } } }),
			provider: () => () => {
				consulted++;
				return [{ name: "write", annotations: { readOnlyHint: true } }];
			},
		});
		assert.deepEqual(lookup.get("write"), { cascadeThreshold: 3, trackErrors: false });
		assert.equal(consulted, 0, "explicitly configured tool short-circuits the port");
	});
});

describe("createToolMetaLookup — fail-open policy (entity)", () => {
	it("throwing provider yields the generic default and warns exactly once", () => {
		const errors: unknown[][] = [];
		const originalError = console.error;
		console.error = (...a: unknown[]) => {
			errors.push(a);
		};
		try {
			const lookup = createToolMetaLookup({
				rules: () => rules(),
				provider: () => () => {
					throw new Error("annotation boom");
				},
			});
			assert.deepEqual(lookup.get("write"), {
				passThrough: false,
				trackErrors: true,
				cascadeThreshold: 8,
			});
			assert.deepEqual(lookup.get("write"), {
				passThrough: false,
				trackErrors: true,
				cascadeThreshold: 8,
			});
		} finally {
			console.error = originalError;
		}
		assert.equal(errors.length, 1, "exactly one warning emitted");
		assert.ok(String(errors[0][0]).includes("annotation boom"));
	});
});

describe("createToolMetaLookup — public surface (entity)", () => {
	it("exposes only get() — resetWarning() is removed", () => {
		const lookup = createToolMetaLookup({ rules: () => rules(), provider: () => () => [] });
		assert.deepEqual(Object.keys(lookup).sort(), ["get"]);
	});
});
