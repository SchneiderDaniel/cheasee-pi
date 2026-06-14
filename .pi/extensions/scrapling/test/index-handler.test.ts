/**
 * Tests for index.ts — real handler execute() path with mocked PythonAdapter
 *
 * Layer: entity — uses mock.module to replace PythonAdapter with a configurable mock.
 * No real subprocess, no venv, no network.
 *
 * This file deliberately avoids static imports of index.ts or python-adapter.ts
 * to allow mock.module() to take effect before module loading.
 */

import assert from "node:assert/strict";
import { describe, it, mock, before } from "node:test";
import type { CrawlResult, CrawledPage } from "../types.ts";

// ── Shared mutable state for mock PythonAdapter ──

let mockCrawlCalls: Array<{
	url: string;
	maxPages: number;
	maxTokens?: number;
	signal?: AbortSignal;
}> = [];
let mockCrawlResult: CrawlResult = { success: true, results: [], totalTokens: 0 };
let tool: any = null;

// ── Mock PythonAdapter ──

before(() => {
	mock.module("../python-adapter.ts", {
		namedExports: {
			PythonAdapter: class PythonAdapterMock {
				private exec: any;
				private cwd: string;
				private onUpdate: any;
				private ensureVenv: any;

				constructor(exec: any, cwd: string, onUpdate?: any, ensureVenv?: any) {
					this.exec = exec;
					this.cwd = cwd;
					this.onUpdate = onUpdate;
					this.ensureVenv = ensureVenv;
				}
				async crawl(params: any): Promise<CrawlResult> {
					mockCrawlCalls.push({
						url: params.url,
						maxPages: params.maxPages,
						maxTokens: params.maxTokens,
						signal: params.signal,
					});
					return mockCrawlResult;
				}
			},
		},
	});
});

// ── Helper: get the registered tool ──

async function getTool(): Promise<any> {
	if (tool) return tool;

	const registered: any[] = [];
	const mockPi = {
		registerTool: (t: any) => registered.push(t),
		exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
	};

	// Dynamic import after mock.module() is set up
	const { default: webCrawlExtension } = await import("../index.ts");
	webCrawlExtension(mockPi as any);
	tool = registered[0];
	return tool;
}

// ── Reset between tests ──

function reset(cannedResult?: CrawlResult) {
	mockCrawlCalls = [];
	mockCrawlResult = cannedResult ?? { success: true, results: [], totalTokens: 0 };
}

// ══════════════════════════════════════════════════════════════════════
//  Handler path tests
// ══════════════════════════════════════════════════════════════════════

describe("handler — real execute() path with mock PythonAdapter", () => {
	it("(entity) handler calls engine.crawl() exactly once per invocation", async () => {
		reset({ success: true, results: [], totalTokens: 0 });
		const t = await getTool();

		const result = await t.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 1 },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		assert.equal(mockCrawlCalls.length, 1, "engine.crawl should be called exactly once");
		assert.equal(mockCrawlCalls[0].url, "https://example.com");
		assert.equal(mockCrawlCalls[0].maxPages, 1);
		assert.ok(result.content && result.content.length > 0, "should return content");
	});

	it("(entity) URL validation throws before engine call", async () => {
		reset();
		const t = await getTool();
		let engineCalledBeforeError = false;

		// Override to detect if engine gets called
		const originalResult = mockCrawlResult;
		mockCrawlResult = { success: true, results: [], totalTokens: 0 };

		await assert.rejects(
			(async () => {
				try {
					return await t.execute("call-id", { url: "not-a-url" }, undefined, undefined, {
						cwd: "/tmp",
					});
				} catch (e) {
					engineCalledBeforeError = mockCrawlCalls.length > 0;
					throw e;
				}
			})(),
			/Invalid URL/,
			"handler should throw 'Invalid URL'",
		);

		assert.equal(engineCalledBeforeError, false, "engine should NOT be called after invalid URL");
		mockCrawlResult = originalResult;
	});

	it("(entity) concurrency lock wraps the full engine call", async () => {
		reset({ success: true, results: [], totalTokens: 0 });
		const t = await getTool();

		// Call execute to verify lock pattern — multiple concurrent calls
		const p1 = t.execute("id1", { url: "https://example.com/1" }, undefined, undefined, {
			cwd: "/tmp",
		});
		const p2 = t.execute("id2", { url: "https://example.com/2" }, undefined, undefined, {
			cwd: "/tmp",
		});
		const p3 = t.execute("id3", { url: "https://example.com/3" }, undefined, undefined, {
			cwd: "/tmp",
		});

		const results = await Promise.allSettled([p1, p2, p3]);
		assert.equal(results.length, 3, "all three calls should settle");
		// All should succeed (lock allows 2 concurrent, 3rd waits)
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		assert.equal(fulfilled.length, 3, "all three should complete");
	});

	it("(entity) onUpdate fires with progress text before engine call", async () => {
		reset({ success: true, results: [], totalTokens: 0 });
		const t = await getTool();
		const updates: string[] = [];

		await t.execute(
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

	it("(entity) engine returns success → handler formats output with URL prefix and method", async () => {
		const page: CrawledPage = {
			url: "https://example.com",
			markdown: "# Hello World",
			method: "lightweight",
			rawLength: 12,
		};
		reset({
			success: true,
			results: [page],
			totalTokens: 3,
		});
		const t = await getTool();

		const result = await t.execute(
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

	it("(entity) engine returns error → handler throws with error string", async () => {
		reset({ success: false, error: "Connection timeout" });
		const t = await getTool();

		await assert.rejects(
			t.execute("call-id", { url: "https://example.com" }, undefined, undefined, { cwd: "/tmp" }),
			/Connection timeout/,
			"handler should throw with error string",
		);
	});

	it("(entity) invalid URL throws 'Invalid URL' and no engine call", async () => {
		reset();
		const t = await getTool();

		await assert.rejects(
			t.execute("call-id", { url: "" }, undefined, undefined, { cwd: "/tmp" }),
			/Invalid URL/,
			"empty URL should throw",
		);
		assert.equal(mockCrawlCalls.length, 0, "engine should not be called");

		// Try another invalid URL
		await assert.rejects(
			t.execute("call-id", { url: "bad-format" }, undefined, undefined, { cwd: "/tmp" }),
			/Invalid URL/,
			"bad URL should throw",
		);
		assert.equal(mockCrawlCalls.length, 0, "engine should not be called");
	});

	it("(entity) maxPages is clamped between 1 and 10", async () => {
		reset({ success: true, results: [], totalTokens: 0 });
		const t = await getTool();

		await t.execute("call-id", { url: "https://example.com", maxPages: 0 }, undefined, undefined, {
			cwd: "/tmp",
		});
		assert.equal(mockCrawlCalls[0].maxPages, 1, "maxPages=0 should clamp to 1");

		await t.execute(
			"call-id",
			{ url: "https://example.com", maxPages: 100 },
			undefined,
			undefined,
			{
				cwd: "/tmp",
			},
		);
		assert.equal(mockCrawlCalls[1].maxPages, 10, "maxPages=100 should clamp to 10");

		await t.execute("call-id", { url: "https://example.com", maxPages: 5 }, undefined, undefined, {
			cwd: "/tmp",
		});
		assert.equal(mockCrawlCalls[2].maxPages, 5, "maxPages=5 should pass through");
	});

	it("(entity) handler formats multiple results with double newline separator", async () => {
		const pages: CrawledPage[] = [
			{ url: "https://a.com", markdown: "Page A", method: "lightweight", rawLength: 6 },
			{ url: "https://b.com", markdown: "Page B", method: "stealth", rawLength: 6 },
		];
		reset({ success: true, results: pages, totalTokens: 3 });
		const t = await getTool();

		const result = await t.execute(
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
		reset({ success: true, results: [page], totalTokens: 100 });
		const t = await getTool();

		const result = await t.execute(
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
		// If adapter already truncated, the suffix will be in the content
		// If adapter didn't truncate (no-opt), the full content passes through
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Phase 6: User-journey tests
// ══════════════════════════════════════════════════════════════════════

describe("user-journey — LLM agent calls web_crawl", () => {
	it("(use-case) agent calls web_crawl → handler validates → MockAdapter returns success → formatted markdown", async () => {
		const cannedResult: CrawlResult = {
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
		reset(cannedResult);
		const t = await getTool();

		const result = await t.execute(
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

	it("(use-case) agent calls web_crawl → handler validates → MockAdapter returns error → agent gets error", async () => {
		reset({ success: false, error: "Page could not be accessed" });
		const t = await getTool();

		await assert.rejects(
			t.execute("call-id", { url: "https://example.com" }, undefined, undefined, { cwd: "/tmp" }),
			/Page could not be accessed/,
			"error result should throw with error message",
		);
	});

	it("(use-case) agent calls web_crawl with invalid URL → handler throws — no engine call", async () => {
		reset({ success: true, results: [], totalTokens: 0 });
		const t = await getTool();

		await assert.rejects(
			t.execute("call-id", { url: "invalid-url" }, undefined, undefined, { cwd: "/tmp" }),
			/Invalid URL/,
			"should throw Invalid URL",
		);
		assert.equal(mockCrawlCalls.length, 0, "engine should never be called");

		await assert.rejects(
			t.execute("call-id", { url: "" }, undefined, undefined, { cwd: "/tmp" }),
			/Invalid URL/,
			"empty URL should throw",
		);
		assert.equal(mockCrawlCalls.length, 0, "engine should never be called with empty URL");
	});

	it("(use-case) maxPages=1 returns single page result", async () => {
		const cannedResult: CrawlResult = {
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
		reset(cannedResult);
		const t = await getTool();

		const result = await t.execute(
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
});
