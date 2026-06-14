/**
 * Tests for mock-adapter.ts — MockAdapter with canned results
 *
 * Layer: entity — no infra, no network, instant.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlResult } from "../types.ts";
import { MockAdapter } from "../mock-adapter.ts";

describe("MockAdapter — construction", () => {
	it("(entity) constructor accepts canned CrawlResult", () => {
		const result: CrawlResult = {
			success: true,
			results: [
				{ url: "https://example.com", markdown: "# Hello", method: "lightweight", rawLength: 7 },
			],
			totalTokens: 2,
		};
		const adapter = new MockAdapter(result);
		assert.ok(adapter instanceof MockAdapter, "should construct MockAdapter");
	});
});

describe("MockAdapter — crawl behavior", () => {
	it("(entity) returns canned success result as-is", async () => {
		const canned: CrawlResult = {
			success: true,
			results: [
				{ url: "https://example.com", markdown: "# Hello", method: "lightweight", rawLength: 7 },
			],
			totalTokens: 2,
		};
		const adapter = new MockAdapter(canned);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.deepEqual(result, canned);
	});

	it("(entity) returns canned error result as-is", async () => {
		const canned: CrawlResult = {
			success: false,
			error: "Connection failed",
		};
		const adapter = new MockAdapter(canned);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.deepEqual(result, canned);
	});

	it("(entity) returns success with multiple CrawledPage entries", async () => {
		const canned: CrawlResult = {
			success: true,
			results: [
				{ url: "https://example.com", markdown: "Page A", method: "lightweight", rawLength: 6 },
				{ url: "https://example.com/page2", markdown: "Page B", method: "stealth", rawLength: 6 },
			],
			totalTokens: 3,
		};
		const adapter = new MockAdapter(canned);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 2 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(result.results.length, 2);
			assert.equal(result.results[0].url, "https://example.com");
			assert.equal(result.results[1].method, "stealth");
		}
	});

	it("(entity) returns empty results array when configured with empty array", async () => {
		const canned: CrawlResult = {
			success: true,
			results: [],
			totalTokens: 0,
		};
		const adapter = new MockAdapter(canned);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(result.results.length, 0);
		}
	});

	it("(entity) resolves synchronously (no real delay)", async () => {
		const canned: CrawlResult = { success: true, results: [], totalTokens: 0 };
		const adapter = new MockAdapter(canned);
		const start = performance.now();
		await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		const elapsed = performance.now() - start;
		assert.ok(elapsed < 50, "should resolve without real delay");
	});

	it("(entity) ignores signal parameter (does not throw)", async () => {
		const canned: CrawlResult = { success: true, results: [], totalTokens: 0 };
		const adapter = new MockAdapter(canned);
		const controller = new AbortController();
		const result = await adapter.crawl({
			url: "https://example.com",
			maxPages: 1,
			signal: controller.signal,
		});
		assert.ok(result.success);
	});
});
