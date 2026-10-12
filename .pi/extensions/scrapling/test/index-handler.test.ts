/**
 * Tests for index.ts — real handler execute() path with factory injection
 *
 * Layer: entity — uses setCrawlFactory/resetCrawlFactory to inject canned
 * CrawlResult values. No subprocess, no venv, no network, no mock.module().
 *
 * Split (issue #2005 Long File refactor): the user journey + factory-injection
 * boundary live in index-handler-factory.test.ts, the schema/cancellation
 * contracts in index-handler-contracts.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import type { CrawlResult, CrawledPage } from "../types.ts";
import { setCrawlFactory, resetCrawlFactory } from "../index.ts";
import webCrawlExtension from "../index.ts";




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
let cannedResult: CrawlResult = { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };

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
//  Phase 3: Handler path tests (preserved from original)
// ══════════════════════════════════════════════════════════════════════

describe("handler — real execute() path with injected crawl factory", () => {
	it("(entity) handler calls injected factory exactly once per invocation", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		const result = await tool.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 1 },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		assert.equal(crawlCalls.length, 1, "injected factory should be called exactly once");
		assert.equal(crawlCalls[0].url, "https://example.com");
		assert.equal(crawlCalls[0].maxPages, 1);
		assert.ok(result.content && result.content.length > 0, "should return content");
	});

	it("(entity) URL validation throws before factory call", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });
		let factoryCalledBeforeError = false;

		// Override to detect if factory gets called
		const originalSet = crawlCalls;
		crawlCalls = [];

		await assert.rejects(
			(async () => {
				try {
					return await tool.execute("call-id", { url: "not-a-url" }, undefined, undefined, {
						cwd: "/tmp",
					});
				} catch (e) {
					factoryCalledBeforeError = crawlCalls.length > 0;
					throw e;
				}
			})(),
			/Invalid URL/,
			"handler should throw 'Invalid URL'",
		);

		assert.equal(factoryCalledBeforeError, false, "factory should NOT be called after invalid URL");
		crawlCalls = originalSet;
	});

	it("(entity) concurrency lock wraps the full execute body", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		// Call execute to verify lock pattern — multiple concurrent calls
		const p1 = tool.execute("id1", { url: "https://example.com/1" }, undefined, undefined, {
			cwd: "/tmp",
		});
		const p2 = tool.execute("id2", { url: "https://example.com/2" }, undefined, undefined, {
			cwd: "/tmp",
		});
		const p3 = tool.execute("id3", { url: "https://example.com/3" }, undefined, undefined, {
			cwd: "/tmp",
		});

		const results = await Promise.allSettled([p1, p2, p3]);
		assert.equal(results.length, 3, "all three calls should settle");
		// All should succeed (lock allows 2 concurrent, 3rd waits)
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		assert.equal(fulfilled.length, 3, "all three should complete");
	});

	it("(entity) onUpdate fires with progress text before factory call", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });
		const updates: string[] = [];

		await tool.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 1 },
			undefined,
			(u: any) => updates.push(u.content?.[0]?.text ?? ""),
			{ cwd: "/tmp" },
		);

		assert.ok(updates.length >= 1, "onUpdate should be called at least once");
		assert.ok(
			updates.some((u) => u.includes("Crawling")),
			"onUpdate should contain progress text",
		);
	});

	it("(entity) success result → handler formats output with URL prefix and method", async () => {
		const page: CrawledPage = {
			url: "https://example.com",
			markdown: "# Hello World",
			method: "lightweight",
			rawLength: 12,
			truncated: false,
		};
		injectFactory({ success: true, results: [page], totalTokens: 3, attempted: 1, failed: [] });

		const result = await tool.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 1 },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const text = result.content[0].text;
		assert.ok(text.includes("--- https://example.com (via lightweight) ---"));
		assert.ok(text.includes("# Hello World"));
	});

	it("(entity) error result → handler returns isError with structured error", async () => {
		injectFactory({ success: false, error: "Connection timeout" });

		const result = await tool.execute(
			"call-id",
			{ url: "https://example.com" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		assert.equal(result.isError, true, "crawl failure should set isError");
		assert.deepEqual(result.structuredContent, {
			ok: false,
			error: { url: "https://example.com", reason: "Connection timeout" },
		});
		assert.ok(
			result.content[0].text.includes("Connection timeout"),
			"content should include the reason",
		);
	});

	it("(entity) invalid URL throws 'Invalid URL' and no factory call", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await assert.rejects(
			tool.execute("call-id", { url: "" }, undefined, undefined, { cwd: "/tmp" }),
			/Invalid URL/,
			"empty URL should throw",
		);
		assert.equal(crawlCalls.length, 0, "factory should not be called");

		// Try another invalid URL
		await assert.rejects(
			tool.execute("call-id", { url: "bad-format" }, undefined, undefined, { cwd: "/tmp" }),
			/Invalid URL/,
			"bad URL should throw",
		);
		assert.equal(crawlCalls.length, 0, "factory should not be called");
	});

	it("(entity) maxPages is clamped between 1 and 10", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await tool.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 0 },
			undefined,
			undefined,
			{
				cwd: "/tmp",
			},
		);
		assert.equal(crawlCalls[0]?.maxPages, 1, "maxPages=0 should clamp to 1");

		await tool.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 100 },
			undefined,
			undefined,
			{
				cwd: "/tmp",
			},
		);
		assert.equal(crawlCalls[1]?.maxPages, 10, "maxPages=100 should clamp to 10");

		await tool.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 5 },
			undefined,
			undefined,
			{
				cwd: "/tmp",
			},
		);
		assert.equal(crawlCalls[2]?.maxPages, 5, "maxPages=5 should pass through");
	});

	it("(entity) handler formats multiple results with double newline separator", async () => {
		const pages: CrawledPage[] = [
			{ url: "https://a.com", markdown: "Page A", method: "lightweight", rawLength: 6, truncated: false },
			{ url: "https://b.com", markdown: "Page B", method: "stealth", rawLength: 6, truncated: false },
		];
		injectFactory({ success: true, results: pages, totalTokens: 3, attempted: 2, failed: [] });

		const result = await tool.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 2 },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const text = result.content[0].text;
		assert.ok(text.includes("Page A"));
		assert.ok(text.includes("Page B"));
		assert.ok(text.includes("--- https://a.com (via lightweight) ---"));
		assert.ok(text.includes("--- https://b.com (via stealth) ---"));
		// Each result section is separated by double newline
		const sections = text.split("\n\n");
		assert.ok(sections.length >= 2, "should have multiple sections separated by newlines");
	});

	it("(entity) token truncation NOT applied in handler (adapter owns it)", async () => {
		const longContent = "a".repeat(400);
		const page: CrawledPage = {
			url: "https://example.com",
			markdown: longContent,
			method: "lightweight",
			rawLength: 400,
			truncated: false,
		};
		injectFactory({ success: true, results: [page], totalTokens: 100, attempted: 1, failed: [] });

		const result = await tool.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 1, maxTokens: 5 },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const text = result.content[0].text;
		// Handler should NOT re-truncate — the content comes as-is from adapter
		assert.ok(
			text.includes(longContent),
			"handler should pass through adapter's truncated content",
		);
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 3: Handler protocol rejection / acceptance tests
// ══════════════════════════════════════════════════════════════════════

describe("handler — protocol allowlist (defense-in-depth)", () => {
	afterEach(() => {
		resetCrawlFactory();
		crawlCalls = [];
		cannedResult = { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
	});

	it("(entity) handler throws for file:// — factory NOT called", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await assert.rejects(
			tool.execute("call-id", { url: "file:///etc/passwd" }, undefined, undefined, {
				cwd: "/tmp",
			}),
			/file:/,
			"file:// should be rejected",
		);
		assert.equal(crawlCalls.length, 0, "factory should NOT be called");
	});

	it("(entity) handler throws for data:// — factory NOT called", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await assert.rejects(
			tool.execute("call-id", { url: "data://text/html,Hello" }, undefined, undefined, {
				cwd: "/tmp",
			}),
			/data:/,
			"data:// should be rejected",
		);
		assert.equal(crawlCalls.length, 0, "factory should NOT be called");
	});

	it("(entity) handler throws for ftp:// — factory NOT called", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await assert.rejects(
			tool.execute("call-id", { url: "ftp://ftp.example.com" }, undefined, undefined, {
				cwd: "/tmp",
			}),
			/ftp:/,
			"ftp:// should be rejected",
		);
		assert.equal(crawlCalls.length, 0, "factory should NOT be called");
	});

	it("(entity) handler throws for javascript: — factory NOT called", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await assert.rejects(
			tool.execute("call-id", { url: "javascript:alert(1)" }, undefined, undefined, {
				cwd: "/tmp",
			}),
			/javascript:/,
			"javascript: should be rejected",
		);
		assert.equal(crawlCalls.length, 0, "factory should NOT be called");
	});

	it("(entity) handler continues normally for http:// — factory called once", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await tool.execute("call-id", { url: "http://example.com" }, undefined, undefined, {
			cwd: "/tmp",
		});

		assert.equal(crawlCalls.length, 1, "factory should be called");
		assert.equal(crawlCalls[0].url, "http://example.com");
	});

	it("(entity) handler continues normally for https:// — factory called once", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await tool.execute("call-id", { url: "https://example.com" }, undefined, undefined, {
			cwd: "/tmp",
		});

		assert.equal(crawlCalls.length, 1, "factory should be called");
		assert.equal(crawlCalls[0].url, "https://example.com");
	});

	it("(entity) handler continues normally for HTTP://EXAMPLE.COM (mixed case) — factory called once", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await tool.execute("call-id", { url: "HTTP://EXAMPLE.COM" }, undefined, undefined, {
			cwd: "/tmp",
		});

		assert.equal(crawlCalls.length, 1, "factory should be called");
		assert.equal(crawlCalls[0].url, "HTTP://EXAMPLE.COM");
	});
});
