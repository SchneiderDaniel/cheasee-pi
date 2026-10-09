// ─── Tests: size-tier classifier (issue #1987) ────────────────────
// Pure text → SizeTier classification. The test-designer's Test Plan
// comment declares `**Tier:** Small|Medium|Large`; the marker feeds the
// tier-scaled timeout policy.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSizeTier, DEFAULT_TIER_SCALE } from "../lib/size-tier.ts";

const c = (body: unknown) => ({ author: "user1", body: body as string });

describe("parseSizeTier — declared **Tier:** marker", () => {
	it("reads a large tier from a Test Plan comment", () => {
		assert.equal(parseSizeTier([c("## Test Plan\n**Tier:** Large")]), "large");
	});

	it("reads medium and small", () => {
		assert.equal(parseSizeTier([c("## Test Plan\n**Tier:** Medium")]), "medium");
		assert.equal(parseSizeTier([c("## Test Plan\n**Tier:** Small")]), "small");
	});

	it("is case-insensitive on the value", () => {
		assert.equal(parseSizeTier([c("## Test Plan\n**Tier:** large")]), "large");
		assert.equal(parseSizeTier([c("## Test Plan\n**Tier:** LARGE")]), "large");
	});

	it("tolerates surrounding whitespace and trailing prose", () => {
		assert.equal(parseSizeTier([c("**Tier:**   Large")]), "large");
		assert.equal(parseSizeTier([c("**Tier:**\tlarge")]), "large");
		assert.equal(parseSizeTier([c("**Tier:** Large — five phases")]), "large");
	});

	it("returns null when the marker is absent", () => {
		assert.equal(parseSizeTier([c("## Test Plan\nno marker here")]), null);
		assert.equal(parseSizeTier([]), null);
	});

	it("skips null/undefined/missing bodies without throwing", () => {
		assert.equal(parseSizeTier([c(null), c(undefined), {} as any]), null);
	});

	it("returns null for an unknown tier value", () => {
		assert.equal(parseSizeTier([c("## Test Plan\n**Tier:** Huge")]), null);
	});

	it("prefers the Test Plan comment over an earlier quoting comment", () => {
		const comments = [c("> **Tier:** Small (quoted from elsewhere)"), c("## Test Plan\n**Tier:** Large")];
		assert.equal(parseSizeTier(comments), "large");
	});

	it("first marker in comment order wins when no Test Plan heading exists", () => {
		const comments = [c("**Tier:** Small"), c("**Tier:** Large")];
		assert.equal(parseSizeTier(comments), "small");
	});
});

describe("DEFAULT_TIER_SCALE — built-in multipliers", () => {
	it("deep-equals small 1 / medium 1.5 / large 2", () => {
		assert.deepEqual(DEFAULT_TIER_SCALE, { small: 1, medium: 1.5, large: 2 });
	});
});
