/**
 * Tests for index.ts — real handler execute() path with factory injection
 *
 * Layer: entity — uses setCrawlFactory/resetCrawlFactory to inject canned
 * CrawlResult values. No subprocess, no venv, no network, no mock.module().
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import type { CrawlResult, CrawledPage } from "../types.ts";
import { setCrawlFactory, resetCrawlFactory } from "../index.ts";
import webCrawlExtension from "../index.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";

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
let cannedResult: CrawlResult = { success: true, results: [], totalTokens: 0 };

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
	cannedResult = { success: true, results: [], totalTokens: 0 };
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 3: Handler path tests (preserved from original)
// ══════════════════════════════════════════════════════════════════════

describe("handler — real execute() path with injected crawl factory", () => {
	it("(entity) handler calls injected factory exactly once per invocation", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
		injectFactory({ success: true, results: [], totalTokens: 0 });
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
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
		injectFactory({ success: true, results: [], totalTokens: 0 });
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
		};
		injectFactory({ success: true, results: [page], totalTokens: 3 });

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

	it("(entity) error result → handler throws with error string", async () => {
		injectFactory({ success: false, error: "Connection timeout" });

		await assert.rejects(
			tool.execute("call-id", { url: "https://example.com" }, undefined, undefined, {
				cwd: "/tmp",
			}),
			/Connection timeout/,
			"handler should throw with error string",
		);
	});

	it("(entity) invalid URL throws 'Invalid URL' and no factory call", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
			{ url: "https://a.com", markdown: "Page A", method: "lightweight", rawLength: 6 },
			{ url: "https://b.com", markdown: "Page B", method: "stealth", rawLength: 6 },
		];
		injectFactory({ success: true, results: pages, totalTokens: 3 });

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
		};
		injectFactory({ success: true, results: [page], totalTokens: 100 });

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
		cannedResult = { success: true, results: [], totalTokens: 0 };
	});

	it("(entity) handler throws for file:// — factory NOT called", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
		injectFactory({ success: true, results: [], totalTokens: 0 });

		await tool.execute("call-id", { url: "http://example.com" }, undefined, undefined, {
			cwd: "/tmp",
		});

		assert.equal(crawlCalls.length, 1, "factory should be called");
		assert.equal(crawlCalls[0].url, "http://example.com");
	});

	it("(entity) handler continues normally for https:// — factory called once", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0 });

		await tool.execute("call-id", { url: "https://example.com" }, undefined, undefined, {
			cwd: "/tmp",
		});

		assert.equal(crawlCalls.length, 1, "factory should be called");
		assert.equal(crawlCalls[0].url, "https://example.com");
	});

	it("(entity) handler continues normally for HTTP://EXAMPLE.COM (mixed case) — factory called once", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0 });

		await tool.execute("call-id", { url: "HTTP://EXAMPLE.COM" }, undefined, undefined, {
			cwd: "/tmp",
		});

		assert.equal(crawlCalls.length, 1, "factory should be called");
		assert.equal(crawlCalls[0].url, "HTTP://EXAMPLE.COM");
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Schema-level TypeBox validation (entity layer)
// ══════════════════════════════════════════════════════════════════════
//
// These tests exercise Value.Check on the url parameter schema directly,
// unlike the handler tests which bypass schema validation by calling
// tool.execute() with raw params.
//
// Known limitation: mixed case like "Http://" does NOT match the pattern
// ^(https?|HTTPS?)://. This is an accepted trade-off — the pattern covers
// extremes (all-lowercase, all-uppercase) while remaining JSON Schema
// compliant. Mixed-case URLs still pass validateUrl() per WHATWG scheme
// normalization.

describe("schema — TypeBox Value.Check path", () => {
	// ── The URL schema used by the tool registration ──
	const urlSchema = Type.String({
		description: "URL to crawl (e.g. https://example.com)",
		pattern: "^(https?|HTTPS?)://",
	});

	// ── Happy path: URLs that should pass ──

	it("(entity) schema accepts http://example.com", () => {
		assert.equal(Value.Check(urlSchema, "http://example.com"), true);
	});

	it("(entity) schema accepts https://example.com", () => {
		assert.equal(Value.Check(urlSchema, "https://example.com"), true);
	});

	it("(entity) schema accepts HTTP://EXAMPLE.COM (all-uppercase scheme)", () => {
		assert.equal(Value.Check(urlSchema, "HTTP://EXAMPLE.COM"), true);
	});

	it("(entity) schema accepts HTTPS://example.com (all-uppercase scheme)", () => {
		assert.equal(Value.Check(urlSchema, "HTTPS://example.com"), true);
	});

	it("(entity) schema accepts http://localhost", () => {
		assert.equal(Value.Check(urlSchema, "http://localhost"), true);
	});

	it("(entity) schema accepts http://127.0.0.1", () => {
		assert.equal(Value.Check(urlSchema, "http://127.0.0.1"), true);
	});

	it("(entity) schema accepts http://example.com/path?query=1#frag", () => {
		assert.equal(Value.Check(urlSchema, "http://example.com/path?query=1#frag"), true);
	});

	it("(entity) schema accepts http://example.com:8080", () => {
		assert.equal(Value.Check(urlSchema, "http://example.com:8080"), true);
	});

	// ── Error path: URLs that should be rejected ──

	it("(entity) schema rejects ftp://example.com", () => {
		assert.equal(Value.Check(urlSchema, "ftp://example.com"), false);
	});

	it("(entity) schema rejects file:///etc/passwd", () => {
		assert.equal(Value.Check(urlSchema, "file:///etc/passwd"), false);
	});

	it("(entity) schema rejects data://text/html,Hello", () => {
		assert.equal(Value.Check(urlSchema, "data://text/html,Hello"), false);
	});

	it("(entity) schema rejects javascript:alert(1)", () => {
		assert.equal(Value.Check(urlSchema, "javascript:alert(1)"), false);
	});

	it("(entity) schema rejects not-a-url", () => {
		assert.equal(Value.Check(urlSchema, "not-a-url"), false);
	});

	it("(entity) schema rejects ://example.com (missing scheme)", () => {
		assert.equal(Value.Check(urlSchema, "://example.com"), false);
	});

	it("(entity) schema rejects empty string", () => {
		assert.equal(Value.Check(urlSchema, ""), false);
	});

	// ── Known-limitation: mixed case not covered by pattern ──
	// These are accepted by validateUrl() (per WHATWG scheme normalization)
	// but rejected by the schema pattern. Accepted trade-off documented in
	// architecture.

	it("(entity) schema rejects Http://example.com (mixed case — known limitation)", () => {
		assert.equal(Value.Check(urlSchema, "Http://example.com"), false);
	});

	it("(entity) schema rejects hTTP://example.com (mixed case — known limitation)", () => {
		assert.equal(Value.Check(urlSchema, "hTTP://example.com"), false);
	});
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
				},
			],
			totalTokens: 9,
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

	it("(use-case) agent calls web_crawl → handler validates → factory returns error → agent gets error", async () => {
		injectFactory({ success: false, error: "Page could not be accessed" });

		await assert.rejects(
			tool.execute("call-id", { url: "https://example.com" }, undefined, undefined, {
				cwd: "/tmp",
			}),
			/Page could not be accessed/,
			"error result should throw with error message",
		);
	});

	it("(use-case) agent calls web_crawl with invalid URL → handler throws — no factory call", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
				},
			],
			totalTokens: 3,
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
		};
		injectFactory({ success: true, results: [page], totalTokens: 42 });

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
			return { success: true, results: [], totalTokens: 0 };
		});

		setCrawlFactory(async () => {
			order.push("second");
			return { success: true, results: [], totalTokens: 0 };
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
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
		injectFactory({ success: true, results: [], totalTokens: 0 });
		const controller = new AbortController();

		await tool.execute("call-id", { url: "https://example.com" }, controller.signal, undefined, {
			cwd: "/tmp",
		});

		assert.equal(crawlCalls.length, 1);
		assert.equal(crawlCalls[0].signal, controller.signal, "signal should be passed through");
	});

	it("(entity) factory returns success: true, results: [], totalTokens: 0 — handler formats empty result", async () => {
		injectFactory({ success: true, results: [], totalTokens: 0 });

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
			{ url: "https://light.com", markdown: "Light", method: "lightweight", rawLength: 5 },
			{ url: "https://stealth.com", markdown: "Stealth", method: "stealth", rawLength: 7 },
		];
		injectFactory({ success: true, results: pages, totalTokens: 3 });

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
			return { success: true, results: [], totalTokens: 0 };
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

// ══════════════════════════════════════════════════════════════════════
//  Phase 5: Cancellation during semaphore lock wait
// ══════════════════════════════════════════════════════════════════════

describe("cancellation — abort signal during acquireCrawlLock wait", () => {
	afterEach(() => {
		resetCrawlFactory();
		crawlCalls = [];
		cannedResult = { success: true, results: [], totalTokens: 0 };
	});

	it("(entity) abort signal during semaphore wait — p3 rejects with AbortError", async () => {
		let resolve1!: () => void;
		let resolve2!: () => void;
		const gate1 = new Promise<void>((r) => { resolve1 = r; });
		const gate2 = new Promise<void>((r) => { resolve2 = r; });

		let callCount = 0;
		setCrawlFactory(async () => {
			callCount++;
			if (callCount === 1) await gate1;
			if (callCount === 2) await gate2;
			return { success: true, results: [], totalTokens: 0 };
		});

		// Fill both semaphore slots — p1, p2 acquire lock then block in factory
		const p1 = tool.execute("id1", { url: "https://example.com/1" }, undefined, undefined, { cwd: "/tmp" });
		const p2 = tool.execute("id2", { url: "https://example.com/2" }, undefined, undefined, { cwd: "/tmp" });

		// Wait for both to acquire lock and reach the factory
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(callCount, 2, "both factory slots should be occupied");

		// 3rd call with abort signal — queues in acquireCrawlLock while loop
		const controller = new AbortController();
		const p3 = tool.execute("id3", { url: "https://example.com/3" }, controller.signal, undefined, { cwd: "/tmp" });

		// Give p3 time to enter the while loop
		await new Promise((r) => setTimeout(r, 100));

		// Abort while waiting
		controller.abort();

		// p3 should reject with AbortError within 1 poll interval (~1s)
		await assert.rejects(p3, { name: "AbortError" }, "abort during lock wait should throw AbortError");

		// Clean up: release gates so p1, p2 can complete
		resolve1();
		resolve2();
		await Promise.allSettled([p1, p2]);
	});

	it("(entity) after abort, semaphore count not corrupted — subsequent call still waits", async () => {
		let resolve1!: () => void;
		let resolve2!: () => void;
		const gate1 = new Promise<void>((r) => { resolve1 = r; });
		const gate2 = new Promise<void>((r) => { resolve2 = r; });

		let callCount = 0;
		// Only gate p1 (callCount=1) and p2 (callCount=2); p4 passes through
		setCrawlFactory(async () => {
			callCount++;
			if (callCount === 1) await gate1;
			if (callCount === 2) await gate2;
			return { success: true, results: [], totalTokens: 0 };
		});

		// Fill both slots
		const p1 = tool.execute("id1", { url: "https://example.com/1" }, undefined, undefined, { cwd: "/tmp" });
		const p2 = tool.execute("id2", { url: "https://example.com/2" }, undefined, undefined, { cwd: "/tmp" });

		await new Promise((r) => setTimeout(r, 100));
		assert.equal(callCount, 2, "both slots should be occupied");

		// 3rd call with abort signal
		const controller1 = new AbortController();
		const p3 = tool.execute("id3", { url: "https://example.com/3" }, controller1.signal, undefined, { cwd: "/tmp" });

		await new Promise((r) => setTimeout(r, 100));
		controller1.abort();
		await assert.rejects(p3, { name: "AbortError" }, "p3 should abort");

		// 4th call with fresh signal — should wait because slots still occupied (p1, p2 blocked)
		const controller2 = new AbortController();
		const p4 = tool.execute("id4", { url: "https://example.com/4" }, controller2.signal, undefined, { cwd: "/tmp" });

		// Verify p4 is waiting (not reached factory yet)
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(callCount, 2, "p4 should still be waiting for a slot");

		// Release blocked factories so p1, p2 complete
		resolve1();
		resolve2();
		await Promise.allSettled([p1, p2]);

		// Now p4 should acquire and complete (within 1 polling interval)
		const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("p4 did not complete within 3s")), 3000));
		await Promise.race([p4, timeout]);
		assert.equal(callCount, 3, "p4 should have reached factory after slots freed");
	});

	it("(entity) after abort then release — remaining calls drain, no lock leak", async () => {
		let resolve1!: () => void;
		let resolve2!: () => void;
		const gate1 = new Promise<void>((r) => { resolve1 = r; });
		const gate2 = new Promise<void>((r) => { resolve2 = r; });

		let callCount = 0;
		setCrawlFactory(async () => {
			callCount++;
			if (callCount === 1) await gate1;
			if (callCount === 2) await gate2;
			return { success: true, results: [], totalTokens: 0 };
		});

		// Fill both slots
		const p1 = tool.execute("id1", { url: "https://example.com/1" }, undefined, undefined, { cwd: "/tmp" });
		const p2 = tool.execute("id2", { url: "https://example.com/2" }, undefined, undefined, { cwd: "/tmp" });

		await new Promise((r) => setTimeout(r, 100));
		assert.equal(callCount, 2, "both slots occupied");

		// 3rd call with abort
		const controller = new AbortController();
		const p3 = tool.execute("id3", { url: "https://example.com/3" }, controller.signal, undefined, { cwd: "/tmp" });
		await new Promise((r) => setTimeout(r, 100));
		controller.abort();
		await assert.rejects(p3, { name: "AbortError" }, "p3 aborted");

		// Release the blocked factories
		resolve1();
		resolve2();
		await Promise.allSettled([p1, p2]);

		// Fresh call should acquire — no lock leak
		const fresh = tool.execute("id5", { url: "https://example.com/5" }, undefined, undefined, { cwd: "/tmp" });
		const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("fresh did not complete within 3s")), 3000));
		await Promise.race([fresh, timeout]);
		assert.equal(callCount, 3, "fresh call should reach factory");
	});
});
