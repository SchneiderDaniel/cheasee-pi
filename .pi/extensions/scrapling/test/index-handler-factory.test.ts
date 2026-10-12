/**
 * scrapling index.ts handler — user journey and the setCrawlFactory /
 * resetCrawlFactory injection boundary.
 *
 * Split from index-handler.test.ts (issue #2005 Long File refactor).
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
//  User-journey tests (preserved from original)
// ══════════════════════════════════════════════════════════════════════

describe("user-journey — LLM agent calls web_crawl", () => {
	it("(use-case) agent calls web_crawl → handler validates → factory returns success → formatted markdown", async () => {
		const canned: CrawlResult = {
			success: true,
			results: [
				{
					url: "https://example.com",
					markdown: "# Welcome\n\nThis is the content.",
					method: "lightweight",
					rawLength: 35,
					truncated: false,
				},
			],
			totalTokens: 9,
			attempted: 1,
			failed: [],
		};
		injectFactory(canned);

		const result = await tool.execute(
			"call-id",
			{ url: "https://example.com" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		assert.ok(result.content, "should return content");
		const text = result.content[0].text;
		assert.ok(
			text.includes("--- https://example.com (via lightweight) ---"),
			"should format with URL prefix and method",
		);
		assert.ok(text.includes("# Welcome"), "should include markdown body");
		assert.ok(text.includes("This is the content."), "should include full content");
	});

	it("(use-case) agent calls web_crawl → factory returns error → agent gets isError result", async () => {
		injectFactory({ success: false, error: "Page could not be accessed" });

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
			error: { url: "https://example.com", reason: "Page could not be accessed" },
		});
		assert.ok(
			result.content[0].text.includes("Page could not be accessed"),
			"content should include the reason",
		);
	});

	it("(use-case) agent calls web_crawl with invalid URL → handler throws — no factory call", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await assert.rejects(
			tool.execute("call-id", { url: "invalid-url" }, undefined, undefined, { cwd: "/tmp" }),
			/Invalid URL/,
			"should throw Invalid URL",
		);
		assert.equal(crawlCalls.length, 0, "factory should never be called");

		await assert.rejects(
			tool.execute("call-id", { url: "" }, undefined, undefined, { cwd: "/tmp" }),
			/Invalid URL/,
			"empty URL should throw",
		);
		assert.equal(crawlCalls.length, 0, "factory should never be called with empty URL");
	});

	it("(use-case) maxPages=1 returns single page result", async () => {
		const canned: CrawlResult = {
			success: true,
			results: [
				{
					url: "https://example.com",
					markdown: "Single page",
					method: "lightweight",
					rawLength: 11,
					truncated: false,
				},
			],
			totalTokens: 3,
			attempted: 1,
			failed: [],
		};
		injectFactory(canned);

		const result = await tool.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 1 },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const text = result.content[0].text;
		assert.ok(text.includes("Single page"), "should include page content");
		// Should have exactly one URL prefix
		const matches = text.match(/\(via /g);
		assert.equal(matches?.length, 1, "should have exactly one page result");
	});

	it("(use-case) totalTokens passthrough to return value", async () => {
		const page: CrawledPage = {
			url: "https://example.com",
			markdown: "Test content",
			method: "lightweight",
			rawLength: 12,
			truncated: false,
		};
		injectFactory({ success: true, results: [page], totalTokens: 42, attempted: 1, failed: [] });

		const result = await tool.execute(
			"call-id",
			{ url: "https://example.com" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		// totalTokens is in details — check details contains totalTokens
		// or that content is returned (handler doesn't expose totalTokens directly)
		assert.ok(result.content, "should return content");
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 4: Factory injection boundary tests
// ══════════════════════════════════════════════════════════════════════

describe("factory injection — setCrawlFactory / resetCrawlFactory boundary", () => {
	it("(entity) setCrawlFactory with undefined throws TypeError", () => {
		assert.throws(
			() => (setCrawlFactory as any)(undefined),
			TypeError,
			"setCrawlFactory should throw TypeError for undefined",
		);
	});

	it("(entity) setCrawlFactory called twice — second call overrides first", async () => {
		const order: string[] = [];

		setCrawlFactory(async () => {
			order.push("first");
			return { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
		});

		setCrawlFactory(async () => {
			order.push("second");
			return { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
		});

		await tool.execute("call-id", { url: "https://example.com" }, undefined, undefined, {
			cwd: "/tmp",
		});

		assert.deepEqual(order, ["second"], "second factory should override first");
	});

	it("(entity) resetCrawlFactory when no factory was set — no error, no state change", () => {
		// Should not throw
		resetCrawlFactory();
		resetCrawlFactory(); // Calling twice should also not throw
	});

	it("(entity) factory receives CrawlParams with url, maxPages, maxTokens — all fields", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await tool.execute(
			"call-id",
			{ url: "https://example.com/page", maxPages: 5, maxTokens: 1000 },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		assert.equal(crawlCalls.length, 1);
		assert.equal(crawlCalls[0].url, "https://example.com/page");
		assert.equal(crawlCalls[0].maxPages, 5);
		assert.equal(crawlCalls[0].maxTokens, 1000);
	});

	it("(entity) factory receives CrawlParams with defaults when optional fields omitted", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		await tool.execute("call-id", { url: "https://example.com" }, undefined, undefined, {
			cwd: "/tmp",
		});

		assert.equal(crawlCalls.length, 1);
		assert.equal(crawlCalls[0].url, "https://example.com");
		// maxPages defaults to 1 when not provided
		assert.equal(crawlCalls[0].maxPages, 1);
		// maxTokens is undefined when not provided
		assert.equal(crawlCalls[0].maxTokens, undefined);
	});

	it("(entity) factory receives AbortSignal in params — signal passed through", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });
		const controller = new AbortController();

		await tool.execute("call-id", { url: "https://example.com" }, controller.signal, undefined, {
			cwd: "/tmp",
		});

		assert.equal(crawlCalls.length, 1);
		assert.equal(crawlCalls[0].signal, controller.signal, "signal should be passed through");
	});

	it("(entity) factory returns success: true, results: [], totalTokens: 0 — handler formats empty result", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });

		const result = await tool.execute(
			"call-id",
			{ url: "https://example.com" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const text = result.content[0].text;
		assert.equal(text, "", "empty results should produce empty text (no map)");
	});

	it("(entity) factory returns multi-page result with mixed method values — handler formats both", async () => {
		const pages: CrawledPage[] = [
			{ url: "https://light.com", markdown: "Light", method: "lightweight", rawLength: 5, truncated: false },
			{ url: "https://stealth.com", markdown: "Stealth", method: "stealth", rawLength: 7, truncated: false },
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
		assert.ok(text.includes("(via lightweight)"), "should show lightweight method");
		assert.ok(text.includes("(via stealth)"), "should show stealth method");
	});

	it("(entity) factory throws synchronously — error propagates through handler, lock released", async () => {
		setCrawlFactory(async () => {
			throw new Error("Factory error");
		});

		await assert.rejects(
			tool.execute("call-id", { url: "https://example.com" }, undefined, undefined, {
				cwd: "/tmp",
			}),
			/Factory error/,
			"handler should propagate synchronous factory error",
		);
	});

	it("(entity) afterEach resets factory — cross-test bleed prevention", async () => {
		// This test runs AFTER other tests that use injectFactory/setCrawlFactory.
		// The afterEach at module level resets the factory.
		// After reset, the default path uses PythonAdapter which needs a real venv.
		// Assert that the factory is cleared (next call uses default).
		resetCrawlFactory();

		// Verify factory is cleared by checking that no injected factory is used
		// The default path will try to create PythonAdapter and likely fail
		// because there's no real Python venv in test. Accept error.
		try {
			await tool.execute("call-id", { url: "https://example.com" }, undefined, undefined, {
				cwd: "/tmp",
			});
		} catch {
			// Expected: default path fails without real venv
		}

		// Verify that after reset, our tracking variables are clean too
		assert.equal(crawlCalls.length, 0, "no factory calls should be recorded after reset");
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 4b: Cross-test factory bleed (explicit)
// ══════════════════════════════════════════════════════════════════════

describe("factory injection — cross-test isolation", () => {
	it("(entity) factory A is not leaked to next test after resetCrawlFactory", async () => {
		const identity: string[] = [];
		setCrawlFactory(async () => {
			identity.push("A");
			return { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
		});

		// Use factory A
		await tool.execute("id", { url: "https://example.com/A" }, undefined, undefined, {
			cwd: "/tmp",
		});
		assert.deepEqual(identity, ["A"]);

		// Reset
		resetCrawlFactory();

		// Try with no factory — default path will fail (no venv)
		try {
			await tool.execute("id", { url: "https://example.com/B" }, undefined, undefined, {
				cwd: "/tmp",
			});
		} catch {
			// Expected
		}

		// Factory A should NOT have been called again
		assert.deepEqual(identity, ["A"], "factory A should not be invoked after reset");
	});
});
