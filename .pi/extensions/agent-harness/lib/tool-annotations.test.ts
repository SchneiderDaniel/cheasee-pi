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
	OPEN_WORLD_CASCADE_THRESHOLD,
} from "./harness-rules.ts";

describe("deriveToolMetaFromAnnotations — absent annotations", () => {
	it("undefined → undefined (caller keeps its conservative default)", () => {
		assert.equal(deriveToolMetaFromAnnotations(undefined), undefined);
	});
});

describe("deriveToolMetaFromAnnotations — MCP defaults for empty annotations", () => {
	it("{} (no hints) → destructive + openWorld true, error-tracked", () => {
		const meta = deriveToolMetaFromAnnotations({});
		assert.ok(meta, "empty annotations still derive a meta");
		assert.equal(meta.destructive, true, "destructiveHint ?? true");
		assert.equal(meta.openWorld, true, "openWorldHint ?? true");
		assert.equal(meta.trackErrors, true, "not read-only");
	});
});

describe("deriveToolMetaFromAnnotations — read-only wins", () => {
	it("{ readOnlyHint: true } → not error-tracked, not destructive", () => {
		const meta = deriveToolMetaFromAnnotations({ readOnlyHint: true });
		assert.equal(meta?.trackErrors, false);
		assert.equal(meta?.destructive, false);
	});

	it("{ readOnlyHint: false } → false is never treated as read-only", () => {
		const meta = deriveToolMetaFromAnnotations({ readOnlyHint: false });
		assert.equal(meta?.trackErrors, true);
	});

	it("{ readOnlyHint: true, destructiveHint: true } → read-only wins", () => {
		const meta = deriveToolMetaFromAnnotations({ readOnlyHint: true, destructiveHint: true });
		assert.equal(meta?.trackErrors, false);
		assert.equal(meta?.destructive, false);
		assert.equal(meta?.cascadeThreshold, undefined, "read-only gets no destructive escalation");
	});
});

describe("deriveToolMetaFromAnnotations — destructive hints", () => {
	it("{ destructiveHint: false } → destructive false, still error-tracked", () => {
		const meta = deriveToolMetaFromAnnotations({ destructiveHint: false });
		assert.equal(meta?.destructive, false);
		assert.equal(meta?.trackErrors, true);
	});

	it("{ destructiveHint: true } → DESTRUCTIVE_CASCADE_THRESHOLD", () => {
		const meta = deriveToolMetaFromAnnotations({ destructiveHint: true });
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

describe("deriveToolMetaFromAnnotations — open-world hints", () => {
	it("{ openWorldHint: true } → openWorld + OPEN_WORLD_CASCADE_THRESHOLD", () => {
		const meta = deriveToolMetaFromAnnotations({ openWorldHint: true });
		assert.equal(meta?.openWorld, true);
		assert.equal(meta?.cascadeThreshold, OPEN_WORLD_CASCADE_THRESHOLD);
	});

	it("OPEN_WORLD_CASCADE_THRESHOLD loosens (>= CASCADE_THRESHOLD)", () => {
		assert.ok(
			OPEN_WORLD_CASCADE_THRESHOLD >= CASCADE_THRESHOLD,
			`open-world threshold ${OPEN_WORLD_CASCADE_THRESHOLD} must be >= ${CASCADE_THRESHOLD}`,
		);
	});

	it("{ openWorldHint: false } → openWorld false, no open-world escalation", () => {
		const meta = deriveToolMetaFromAnnotations({ openWorldHint: false });
		assert.equal(meta?.openWorld, false);
		assert.notEqual(meta?.cascadeThreshold, OPEN_WORLD_CASCADE_THRESHOLD);
	});

	it("{ destructiveHint: true, openWorldHint: true } → destructive threshold wins", () => {
		const meta = deriveToolMetaFromAnnotations({ destructiveHint: true, openWorldHint: true });
		assert.equal(meta?.cascadeThreshold, DESTRUCTIVE_CASCADE_THRESHOLD);
	});
});

describe("deriveToolMetaFromAnnotations — idempotent hint", () => {
	it("idempotentHint true carried verbatim", () => {
		assert.equal(deriveToolMetaFromAnnotations({ idempotentHint: true })?.idempotent, true);
	});

	it("idempotentHint false carried verbatim", () => {
		assert.equal(deriveToolMetaFromAnnotations({ idempotentHint: false })?.idempotent, false);
	});

	it("absent idempotentHint → undefined", () => {
		assert.equal(deriveToolMetaFromAnnotations({})?.idempotent, undefined);
	});
});

describe("deriveToolMetaFromAnnotations — robustness", () => {
	it("non-boolean hint values do not throw (strict === / ?? semantics)", () => {
		const meta = deriveToolMetaFromAnnotations({
			readOnlyHint: "yes",
			destructiveHint: "yes",
			openWorldHint: 0,
		} as never);
		assert.ok(meta, "should still derive");
		assert.equal(meta.destructive, false, "non-boolean destructiveHint !== true");
		assert.equal(meta.openWorld, false, "non-boolean openWorldHint !== true");
	});

	it("never mutates the input annotations object", () => {
		const annotations = { readOnlyHint: true };
		deriveToolMetaFromAnnotations(annotations);
		assert.deepEqual(annotations, { readOnlyHint: true });
	});
});
