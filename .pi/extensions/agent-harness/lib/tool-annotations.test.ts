/**
 * Tests for tool-annotations.ts — pure MCP-annotation → ToolMeta mapping.
 *
 * No pi runtime, no network, no SDK import — the module maps structural
 * annotation objects only. Missing hints are never treated as safe: MCP
 * defaults (`destructiveHint ?? true`, `openWorldHint ?? true`) apply.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	deriveToolMetaFromAnnotations,
} from "./tool-annotations.ts";
import {
	CASCADE_THRESHOLD,
	DESTRUCTIVE_CASCADE_THRESHOLD,
} from "./harness-rules.ts";

describe("deriveToolMetaFromAnnotations — absent annotations", () => {
	it("undefined + any threshold → undefined (caller keeps its conservative default)", () => {
		assert.equal(deriveToolMetaFromAnnotations(undefined, 8), undefined);
		assert.equal(deriveToolMetaFromAnnotations(undefined, 1), undefined);
		assert.equal(deriveToolMetaFromAnnotations(undefined, 32), undefined);
	});
});

describe("deriveToolMetaFromAnnotations — MCP defaults for empty annotations", () => {
	it("{} (no hints), threshold 8 → destructive + openWorld true, error-tracked, threshold 4", () => {
		const meta = deriveToolMetaFromAnnotations({}, 8);
		assert.ok(meta, "empty annotations still derive a meta");
		assert.equal(meta.destructive, true, "destructiveHint ?? true");
		assert.equal(meta.openWorld, true, "openWorldHint ?? true");
		assert.equal(meta.trackErrors, true, "not read-only");
		assert.equal(meta.cascadeThreshold, DESTRUCTIVE_CASCADE_THRESHOLD, "MCP destructive default");
	});
});

describe("deriveToolMetaFromAnnotations — read-only wins", () => {
	it("{ readOnlyHint: true }, threshold 8 → no error tracking, not destructive, no threshold", () => {
		const meta = deriveToolMetaFromAnnotations({ readOnlyHint: true }, 8);
		assert.equal(meta?.trackErrors, false);
		assert.equal(meta?.destructive, false);
		assert.equal(meta?.openWorld, false);
		assert.equal(meta?.cascadeThreshold, undefined);
	});

	it("{ readOnlyHint: false }, threshold 8 → false is never read-only, threshold 4", () => {
		const meta = deriveToolMetaFromAnnotations({ readOnlyHint: false }, 8);
		assert.equal(meta?.trackErrors, true);
		assert.equal(meta?.destructive, true, "absent destructiveHint defaults true");
		assert.equal(meta?.cascadeThreshold, DESTRUCTIVE_CASCADE_THRESHOLD);
	});

	it("{ readOnlyHint: true, destructiveHint: true } → read-only wins, no threshold", () => {
		const meta = deriveToolMetaFromAnnotations(
			{ readOnlyHint: true, destructiveHint: true },
			8,
		);
		assert.equal(meta?.trackErrors, false);
		assert.equal(meta?.destructive, false);
		assert.equal(meta?.cascadeThreshold, undefined, "read-only gets no destructive escalation");
	});
});

describe("deriveToolMetaFromAnnotations — destructive classification", () => {
	it("{ destructiveHint: false }, threshold 8 → destructive false, no threshold", () => {
		const meta = deriveToolMetaFromAnnotations({ destructiveHint: false }, 8);
		assert.equal(meta?.destructive, false);
		assert.equal(meta?.trackErrors, true);
		assert.equal(meta?.cascadeThreshold, undefined);
	});

	it("{ destructiveHint: true }, threshold 8 → destructive threshold 4", () => {
		const meta = deriveToolMetaFromAnnotations({ destructiveHint: true }, 8);
		assert.equal(meta?.destructive, true);
		assert.equal(meta?.cascadeThreshold, DESTRUCTIVE_CASCADE_THRESHOLD);
	});

	it("DESTRUCTIVE_CASCADE_THRESHOLD tightens (<= CASCADE_THRESHOLD)", () => {
		assert.ok(
			DESTRUCTIVE_CASCADE_THRESHOLD <= CASCADE_THRESHOLD,
			`destructive threshold ${DESTRUCTIVE_CASCADE_THRESHOLD} must be <= ${CASCADE_THRESHOLD}`,
		);
	});
});

describe("deriveToolMetaFromAnnotations — open-world is classification only", () => {
	it("{ openWorldHint: true }, threshold 8 → openWorld true, destructive default, threshold 4", () => {
		const meta = deriveToolMetaFromAnnotations({ openWorldHint: true }, 8);
		assert.equal(meta?.openWorld, true);
		assert.equal(meta?.destructive, true, "absent destructiveHint defaults true");
		assert.equal(meta?.cascadeThreshold, DESTRUCTIVE_CASCADE_THRESHOLD, "openWorld never loosens");
	});

	it("{ openWorldHint: false }, threshold 8 → openWorld false, destructive default, threshold 4", () => {
		const meta = deriveToolMetaFromAnnotations({ openWorldHint: false }, 8);
		assert.equal(meta?.openWorld, false);
		assert.equal(meta?.destructive, true);
		assert.equal(meta?.cascadeThreshold, DESTRUCTIVE_CASCADE_THRESHOLD);
	});

	it("{ destructiveHint: false, openWorldHint: true }, threshold 8 → openWorld alone sets no threshold", () => {
		const meta = deriveToolMetaFromAnnotations(
			{ destructiveHint: false, openWorldHint: true },
			8,
		);
		assert.equal(meta?.destructive, false);
		assert.equal(meta?.openWorld, true);
		assert.equal(meta?.cascadeThreshold, undefined);
	});
});

describe("deriveToolMetaFromAnnotations — min-clamp against configured threshold", () => {
	const cases: Array<[number, number]> = [
		[20, DESTRUCTIVE_CASCADE_THRESHOLD],
		[8, DESTRUCTIVE_CASCADE_THRESHOLD],
		[4, DESTRUCTIVE_CASCADE_THRESHOLD],
		[2, 2],
		[1, 1],
	];

	for (const [configured, expected] of cases) {
		it(`configured ${configured} → derived ${expected} (never widened)`, () => {
			const meta = deriveToolMetaFromAnnotations({ destructiveHint: true }, configured);
			assert.equal(meta?.cascadeThreshold, expected);
		});
	}

	it("invariant: destructive tool never derives above the effective threshold", () => {
		for (let threshold = 1; threshold <= 32; threshold++) {
			const meta = deriveToolMetaFromAnnotations({ destructiveHint: true }, threshold);
			const derived = meta?.cascadeThreshold as number;
			assert.ok(
				Number.isInteger(derived) && derived > 0,
				`derived ${derived} must be a finite positive integer`,
			);
			assert.ok(
				derived <= threshold,
				`derived ${derived} must not exceed configured ${threshold}`,
			);
		}
	});
});

describe("deriveToolMetaFromAnnotations — idempotent hint", () => {
	it("idempotentHint true carried verbatim", () => {
		assert.equal(deriveToolMetaFromAnnotations({ idempotentHint: true }, 8)?.idempotent, true);
	});

	it("idempotentHint false carried verbatim", () => {
		assert.equal(deriveToolMetaFromAnnotations({ idempotentHint: false }, 8)?.idempotent, false);
	});

	it("absent idempotentHint → undefined", () => {
		assert.equal(deriveToolMetaFromAnnotations({}, 8)?.idempotent, undefined);
	});
});

describe("deriveToolMetaFromAnnotations — robustness", () => {
	it("non-boolean hint values do not throw (strict === / ?? semantics)", () => {
		const meta = deriveToolMetaFromAnnotations(
			{
				readOnlyHint: "yes",
				destructiveHint: "yes",
				openWorldHint: 0,
			} as never,
			8,
		);
		assert.ok(meta, "should still derive");
		assert.equal(meta.trackErrors, true, "not read-only");
		assert.equal(meta.destructive, false, "non-boolean destructiveHint !== true");
		assert.equal(meta.openWorld, false, "non-boolean openWorldHint !== true");
		assert.equal(meta.cascadeThreshold, undefined, "non-destructive → no threshold");
	});

	it("never mutates the input annotations object", () => {
		const annotations = { readOnlyHint: true };
		deriveToolMetaFromAnnotations(annotations, 8);
		assert.deepEqual(annotations, { readOnlyHint: true });
	});
});
