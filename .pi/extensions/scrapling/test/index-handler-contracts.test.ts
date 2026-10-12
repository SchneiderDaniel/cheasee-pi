/**
 * scrapling index.ts handler — TypeBox schema contract, cancellation during
 * lock acquisition and the structuredContent contract.
 *
 * Split from index-handler.test.ts (issue #2005 Long File refactor).
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import type { CrawlResult, CrawledPage } from "../types.ts";
import { setCrawlFactory, resetCrawlFactory } from "../index.ts";
import webCrawlExtension from "../index.ts";
import { Type } from "typebox";
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
//  Phase 5: Cancellation during semaphore lock wait
// ══════════════════════════════════════════════════════════════════════

describe("cancellation — abort signal during acquireCrawlLock wait", () => {
	afterEach(() => {
		resetCrawlFactory();
		crawlCalls = [];
		cannedResult = { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
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
			return { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
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
			return { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
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
			return { success: true, results: [], totalTokens: 0, attempted: 0, failed: [] };
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

	it("(entity) abort during execution → handler throws AbortError, not isError", async () => {
		const controller = new AbortController();
		// Simulates the adapter converting an aborted (killed) subprocess into an
		// ordinary failure result while the signal is already aborted.
		setCrawlFactory(async () => {
			controller.abort();
			return { success: false, error: "Subprocess killed by SIGTERM" };
		});

		await assert.rejects(
			tool.execute("id", { url: "https://example.com" }, controller.signal, undefined, { cwd: "/tmp" }),
			{ name: "AbortError" },
			"abort during execution must surface as AbortError, not an isError result",
		);
	});

	it("(entity) lock released after abort during execution — next call succeeds", async () => {
		const controller = new AbortController();
		setCrawlFactory(async () => {
			controller.abort();
			return { success: false, error: "Subprocess killed by SIGTERM" };
		});
		await assert.rejects(
			tool.execute("id", { url: "https://example.com" }, controller.signal, undefined, { cwd: "/tmp" }),
			{ name: "AbortError" },
		);

		injectFactory({ success: true, results: [], totalTokens: 0, attempted: 0, failed: [] });
		const ok = await tool.execute("id2", { url: "https://example.com" }, undefined, undefined, {
			cwd: "/tmp",
		});
		assert.equal(ok.isError, undefined, "subsequent call should not inherit abort state");
		assert.equal(Value.Check(crawlOutputSchema, ok.structuredContent), true);
	});
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
			{ url: "https://a.com", markdown: "A", method: "lightweight", rawLength: 1, truncated: false },
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
			{ url: "https://a.com", markdown: "Page A", method: "lightweight", rawLength: 6, truncated: false },
			{ url: "https://b.com", markdown: "Page B", method: "stealth", rawLength: 6, truncated: false },
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
		const sc = result.structuredContent as { ok: boolean; truncated: boolean; pages: Array<{ truncated: boolean }> };
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
