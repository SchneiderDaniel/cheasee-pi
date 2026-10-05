/**
 * Tests for structured-output.ts — TypeBox outputSchema + pure projector.
 *
 * Layer: entity — pure functions, no I/O, no subprocess, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { CrawlResult, CrawledPage } from "../types.ts";
import { crawlOutputSchema, toStructuredContent } from "../structured-output.ts";

// ── Fixtures ──

function page(over: Partial<CrawledPage> = {}): CrawledPage {
	return {
		url: "https://example.com",
		markdown: "# Hello",
		method: "lightweight",
		rawLength: 7,
		truncated: false,
		...over,
	};
}

function successResult(
	over: Partial<Extract<CrawlResult, { success: true }>> = {},
): CrawlResult {
	return {
		success: true,
		results: [page()],
		totalTokens: 2,
		attempted: 1,
		failed: [],
		...over,
	};
}

// ── Tests ──

describe("structured-output — success projection", () => {
	it("(entity) projects a success result to the documented shape", () => {
		const out = toStructuredContent(successResult());
		assert.deepEqual(out, {
			ok: true,
			pages: [{ url: "https://example.com", markdown: "# Hello", method: "lightweight", truncated: false }],
			totalPages: 1,
			attempted: 1,
			failed: [],
			truncated: false,
		});
	});

	it("(entity) output passes Value.Check against crawlOutputSchema", () => {
		assert.equal(Value.Check(crawlOutputSchema, toStructuredContent(successResult())), true);
	});

	it("(entity) top-level truncated is false when every page is untruncated", () => {
		const out = toStructuredContent(successResult({ results: [page(), page()] }));
		assert.equal(out.ok && out.truncated, false);
	});

	it("(entity) top-level truncated is true when at least one page is truncated", () => {
		const out = toStructuredContent(
			successResult({ results: [page(), page({ truncated: true })] }),
		);
		assert.equal(out.ok && out.truncated, true);
	});

	it("(entity) totalPages equals pages.length and preserves adapter counts", () => {
		const out = toStructuredContent(
			successResult({
				results: [page(), page({ url: "https://b.com" }), page({ url: "https://c.com" })],
				attempted: 4,
				failed: ["boom"],
			}),
		);
		assert.ok(out.ok);
		assert.equal(out.totalPages, out.pages.length);
		assert.equal(out.totalPages, 3);
		assert.equal(out.attempted, 4);
		assert.deepEqual(out.failed, ["boom"]);
	});

	it("(entity) empty success → pages:[], totalPages:0, truncated:false, ok:true", () => {
		const out = toStructuredContent(successResult({ results: [], attempted: 0 }));
		assert.deepEqual(out, {
			ok: true,
			pages: [],
			totalPages: 0,
			attempted: 0,
			failed: [],
			truncated: false,
		});
		assert.equal(Value.Check(crawlOutputSchema, out), true);
	});
});

describe("structured-output — error projection", () => {
	it("(entity) projects the failure reason with the requested URL", () => {
		const out = toStructuredContent(
			{ success: false, error: "Connection timeout" },
			"https://example.com",
		);
		assert.deepEqual(out, {
			ok: false,
			error: { url: "https://example.com", reason: "Connection timeout" },
		});
	});

	it("(entity) error output passes Value.Check against crawlOutputSchema", () => {
		const out = toStructuredContent({ success: false, error: "boom" }, "https://x.com");
		assert.equal(Value.Check(crawlOutputSchema, out), true);
	});
});

describe("structured-output — schema conformance", () => {
	it("(entity) schema serializes to JSON with both union branches", () => {
		const json = JSON.parse(JSON.stringify(crawlOutputSchema)) as Record<string, unknown>;
		const serialized = JSON.stringify(json);
		assert.ok(serialized.includes('"pages"'), "success branch should be present");
		assert.ok(serialized.includes('"error"'), "error branch should be present");
		assert.ok(serialized.includes('"ok"'), "ok discriminator should be present");
	});

	it("(entity) Value.Check rejects a success output missing pages", () => {
		assert.equal(Value.Check(crawlOutputSchema, { ok: true, totalPages: 0 }), false);
	});

	it("(entity) Value.Check rejects an error output missing error.reason", () => {
		assert.equal(Value.Check(crawlOutputSchema, { ok: false, error: {} }), false);
	});

	it("(entity) Value.Check rejects a wrong ok literal", () => {
		assert.equal(Value.Check(crawlOutputSchema, { ok: "yes" }), false);
	});
});

describe("structured-output — purity", () => {
	it("(entity) same input twice → deepEqual output", () => {
		const input = successResult({ results: [page(), page({ truncated: true })] });
		assert.deepEqual(toStructuredContent(input), toStructuredContent(input));
	});

	it("(entity) does not mutate the input result", () => {
		const input = successResult({ results: [page()] });
		const snapshot = JSON.parse(JSON.stringify(input));
		toStructuredContent(input);
		assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
	});
});
