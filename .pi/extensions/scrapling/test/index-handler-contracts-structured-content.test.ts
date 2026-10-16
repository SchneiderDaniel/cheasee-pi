/**
 * scrapling index.ts handler — structuredContent contract and the
 * registered tool definition (outputSchema, annotations).
 *
 * Split from index-handler-contracts.test.ts (issue #2057: the Prettier
 * sweep pushed the contracts file past the pinned CodeFlow 500-segment ceiling).
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import type { CrawlResult, CrawledPage } from "../types.ts";
import { setCrawlFactory, resetCrawlFactory } from "../index.ts";
import webCrawlExtension from "../index.ts";
import { Value } from "typebox/value";
import { crawlOutputSchema } from "../structured-output.ts";

// ── Register tool once ──

const tools: any[] = [];

const mockPi = {
	registerTool: (t: any) => tools.push(t),
	exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
};

webCrawlExtension(mockPi as any);
const tool = tools[0];

// ── Tracking state for injected factory ──

interface CrawlCall {
	url: string;
	maxPages: number;
	maxTokens?: number;
	signal?: AbortSignal;
}

let crawlCalls: CrawlCall[] = [];
let cannedResult: CrawlResult = {
	success: true,
	results: [],
	totalTokens: 0,
	attempted: 0,
	failed: [],
};

/**
 * Inject a factory that records calls and returns the current cannedResult.
 * Each test calls this before exercising the handler.
 */
function injectFactory(result: CrawlResult): void {
	crawlCalls = [];
	cannedResult = result;
	setCrawlFactory(async (params) => {
		crawlCalls.push({
			url: params.url,
			maxPages: params.maxPages,
			maxTokens: params.maxTokens,
			signal: params.signal,
		});
		return cannedResult;
	});
}

// ── Reset between tests ──

afterEach(() => {
	resetCrawlFactory();
	crawlCalls = [];
	cannedResult = { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
});

// ══════════════════════════════════════════════════════════════════════
//  structuredContent + tool contract (entity)
// ══════════════════════════════════════════════════════════════════════

describe("handler — structuredContent contract", () => {
	afterEach(() => {
		resetCrawlFactory();
		crawlCalls = [];
		cannedResult = { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
	});

	it("(entity) success → structuredContent passes crawlOutputSchema", async () => {
		const pages: CrawledPage[] = [
			{
				url: "https://a.com",
				markdown: "A",
				method: "lightweight",
				rawLength: 1,
				truncated: false,
			},
		];
		injectFactory({ success: true, results: pages, totalTokens: 1, attempted: 1, failed: [] });

		const result = await tool.execute("id", { url: "https://a.com" }, undefined, undefined, {
			cwd: "/tmp",
		});

		assert.equal(Value.Check(crawlOutputSchema, result.structuredContent), true);
		assert.deepEqual(result.structuredContent, {
			ok: true,
			pages: [{ url: "https://a.com", markdown: "A", method: "lightweight", truncated: false }],
			totalPages: 1,
			attempted: 1,
			failed: [],
			truncated: false,
		});
	});

	it("(entity) content stays combined markdown; structuredContent not serialized into content", async () => {
		const pages: CrawledPage[] = [
			{
				url: "https://a.com",
				markdown: "Page A",
				method: "lightweight",
				rawLength: 6,
				truncated: false,
			},
			{
				url: "https://b.com",
				markdown: "Page B",
				method: "stealth",
				rawLength: 6,
				truncated: false,
			},
		];
		injectFactory({ success: true, results: pages, totalTokens: 3, attempted: 2, failed: [] });

		const result = await tool.execute(
			"id",
			{ url: "https://a.com", maxPages: 2 },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		const text = result.content[0].text;
		assert.ok(text.includes("--- https://a.com (via lightweight) ---"));
		assert.ok(text.includes("--- https://b.com (via stealth) ---"));
		assert.ok(!text.includes("totalPages"), "structuredContent must not leak into model content");
	});

	it("(entity) truncated page surfaces in content notice and structuredContent", async () => {
		const pages: CrawledPage[] = [
			{
				url: "https://a.com",
				markdown: "abc\n\n[... truncated at ~5 tokens (100 total).]",
				method: "lightweight",
				rawLength: 400,
				truncated: true,
			},
		];
		injectFactory({ success: true, results: pages, totalTokens: 100, attempted: 1, failed: [] });

		const result = await tool.execute(
			"id",
			{ url: "https://a.com", maxTokens: 5 },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.ok(result.content[0].text.includes("[... truncated at"));
		const sc = result.structuredContent as {
			ok: boolean;
			truncated: boolean;
			pages: Array<{ truncated: boolean }>;
		};
		assert.equal(sc.truncated, true);
		assert.equal(sc.pages[0].truncated, true);
	});

	it("(entity) registered definition exposes outputSchema", () => {
		assert.ok(tool.outputSchema, "web_crawl should declare an outputSchema");
		assert.equal(
			Value.Check(tool.outputSchema, {
				ok: true,
				pages: [],
				totalPages: 0,
				attempted: 0,
				failed: [],
				truncated: false,
			}),
			true,
		);
	});

	it("(entity) registered definition exposes annotations { readOnlyHint, openWorldHint }", () => {
		assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: true });
	});

	it("(entity) lock is released on the isError return path", async () => {
		injectFactory({ success: false, error: "boom" });
		const failed = await tool.execute("id", { url: "https://example.com" }, undefined, undefined, {
			cwd: "/tmp",
		});
		assert.equal(failed.isError, true);

		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });
		const ok = await tool.execute("id", { url: "https://example.com" }, undefined, undefined, {
			cwd: "/tmp",
		});
		assert.equal(ok.isError, undefined, "subsequent call should not inherit error state");
		assert.equal(Value.Check(crawlOutputSchema, ok.structuredContent), true);
	});
});
