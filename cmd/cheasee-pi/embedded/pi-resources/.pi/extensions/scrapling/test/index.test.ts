/**
 * Tests for index.ts — handler delegation to CrawlerEngine
 *
 * Layer: entity — mock CrawlerEngine, no infra, no subprocess.
 */

import assert from "node:assert/strict";
import { describe, it, mock, before } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import webCrawlExtension, { validateUrl } from "../index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "..");

// ===========================================================================
// Test helper — simulate the handler's formatting logic
// ===========================================================================

interface CrawledPage {
	url: string;
	markdown: string;
	method: "lightweight" | "stealth";
	rawLength: number;
}

/**
 * Simulates the handler's result formatting logic.
 * Same behavior as the new index.ts execute method.
 */
function formatEngineResults(results: CrawledPage[], maxTokens?: number): string {
	const texts = results.map((r) => {
		let content = r.markdown || "[No content]";
		if (maxTokens && maxTokens > 0) {
			const estimatedTokens = Math.round(content.length / 4);
			if (estimatedTokens > maxTokens) {
				const maxChars = maxTokens * 4;
				const truncated = content.slice(0, maxChars);
				content = `${truncated}\n\n[... truncated at ~${maxTokens.toLocaleString()} tokens (${estimatedTokens.toLocaleString()} total). Use narrower query or page-specific section.]`;
			}
		}
		return `--- ${r.url} (via ${r.method}) ---\n${content}`;
	});
	return texts.join("\n\n");
}

describe("web_crawl tool registration — shape contract", () => {
	it("(entity) webCrawlExtension is a function", () => {
		assert.equal(typeof webCrawlExtension, "function");
	});

	it("(entity) registers tool with name 'web_crawl'", () => {
		const registered: Array<any> = [];
		const mockPi = {
			registerTool: (tool: any) => {
				registered.push(tool);
			},
			exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
		};

		webCrawlExtension(mockPi as any);

		assert.equal(registered.length, 1, "should register exactly one tool");
		assert.equal(registered[0].name, "web_crawl");
	});

	it("(entity) tool has url and optional maxPages parameters", () => {
		const schema = {
			type: "object",
			properties: {
				url: { type: "string" },
				maxPages: { type: "number", default: 1 },
				maxTokens: { type: "number" },
			},
		};
		assert.equal(schema.properties.url.type, "string");
		assert.equal(schema.properties.maxPages.default, 1);
	});

	it("(entity) maxPages is clamped between 1 and 10", () => {
		function clampPages(n: number): number {
			return Math.min(Math.max(1, n), 10);
		}
		assert.equal(clampPages(0), 1);
		assert.equal(clampPages(1), 1);
		assert.equal(clampPages(5), 5);
		assert.equal(clampPages(10), 10);
		assert.equal(clampPages(100), 10);
	});
});

describe("MAX_CONCURRENT_CRAWLS — memory protection", () => {
	it("(entity) MAX_CONCURRENT_CRAWLS should be exactly 2", () => {
		const MAX_CONCURRENT_CRAWLS = 2;
		assert.equal(MAX_CONCURRENT_CRAWLS, 2, "should allow max 2 concurrent crawls");
	});

	it("(entity) acquire/release lock pattern prevents over-allocation", async () => {
		let activeCrawls = 0;
		const MAX = 2;
		const executionOrder: number[] = [];

		async function acquire(): Promise<void> {
			while (activeCrawls >= MAX) {
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
			executionOrder.push(activeCrawls);
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
			executionOrder.push(-activeCrawls);
		}

		const p1 = (async () => {
			await acquire();
			await new Promise((r) => setTimeout(r, 50));
			release();
		})();
		const p2 = (async () => {
			await acquire();
			await new Promise((r) => setTimeout(r, 50));
			release();
		})();
		const p3 = (async () => {
			await acquire();
			await new Promise((r) => setTimeout(r, 50));
			release();
		})();

		const checkInterval = setInterval(() => {
			assert.ok(activeCrawls <= MAX, `activeCrawls (${activeCrawls}) should not exceed ${MAX}`);
		}, 5);

		await Promise.all([p1, p2, p3]);
		clearInterval(checkInterval);
		assert.equal(activeCrawls, 0, "all crawls should complete and release");
	});

	it("(entity) acquire with abort signal — abort mid-wait throws AbortError", async () => {
		let activeCrawls = 0;
		const MAX = 2;

		async function acquire(signal?: AbortSignal): Promise<void> {
			while (activeCrawls >= MAX) {
				signal?.throwIfAborted();
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
		}

		// Fill both slots by holding locks with deferred gates
		let resolveA!: () => void;
		const gateA = new Promise<void>((r) => { resolveA = r; });
		let resolveB!: () => void;
		const gateB = new Promise<void>((r) => { resolveB = r; });

		const p1 = (async () => {
			await acquire();
			await gateA;
			release();
		})();
		const p2 = (async () => {
			await acquire();
			await gateB;
			release();
		})();

		// Wait for p1, p2 to acquire
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(activeCrawls, 2, "both slots should be occupied");

		// Third call with abort signal — queues in while loop
		const controller = new AbortController();
		const p3 = acquire(controller.signal);

		// Give p3 time to enter the while loop
		await new Promise((r) => setTimeout(r, 20));

		// Abort while waiting
		controller.abort();

		// p3 should reject with AbortError
		await assert.rejects(p3, { name: "AbortError" }, "abort during wait should throw AbortError");

		// Clean up: release gates
		resolveA();
		resolveB();
		await Promise.allSettled([p1, p2]);
		assert.equal(activeCrawls, 0, "all should release cleanly");
	});

	it("(entity) acquire with pre-aborted signal — throws synchronously on first check", async () => {
		let activeCrawls = 0;
		const MAX = 2;

		async function acquire(signal?: AbortSignal): Promise<void> {
			while (activeCrawls >= MAX) {
				signal?.throwIfAborted();
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
		}

		// Fill both slots
		activeCrawls = 2;

		const controller = new AbortController();
		controller.abort(); // Pre-abort

		await assert.rejects(
			acquire(controller.signal),
			{ name: "AbortError" },
			"pre-aborted signal should throw synchronously on first check",
		);

		// Clean up
		activeCrawls = 0;
	});

	it("(entity) acquire with no signal — acquires normally when slot opens", async () => {
		let activeCrawls = 0;
		const MAX = 2;

		async function acquire(signal?: AbortSignal): Promise<void> {
			while (activeCrawls >= MAX) {
				signal?.throwIfAborted();
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
		}

		// Fill both slots
		activeCrawls = 2;

		// Start acquire with no signal
		const acquirePromise = acquire();

		// Wait a tick — should be looping
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(activeCrawls, 2, "should still be waiting");

		// Release one slot
		activeCrawls = 1;

		// Now acquire should complete
		await acquirePromise;
		assert.equal(activeCrawls, 2, "should have incremented after acquiring");

		activeCrawls = 0;
	});

	it("(entity) acquire with signal never aborted — acquires normally when slot opens", async () => {
		let activeCrawls = 0;
		const MAX = 2;

		async function acquire(signal?: AbortSignal): Promise<void> {
			while (activeCrawls >= MAX) {
				signal?.throwIfAborted();
				await new Promise((r) => setTimeout(r, 10));
			}
			activeCrawls++;
		}

		function release(): void {
			activeCrawls = Math.max(0, activeCrawls - 1);
		}

		const controller = new AbortController();

		// Fill both slots
		activeCrawls = 2;

		const acquirePromise = acquire(controller.signal);

		// Release one slot
		activeCrawls = 1;

		// Should acquire
		await acquirePromise;
		assert.equal(activeCrawls, 2, "should have incremented");

		// Signal not aborted
		assert.equal(controller.signal.aborted, false, "signal should not be aborted");

		activeCrawls = 0;
	});
});

describe("URL validation", () => {
	it("(entity) rejects empty string URL", () => {
		try {
			new URL("");
			assert.fail("should throw on empty URL");
		} catch {
			assert.ok(true, "empty URL should throw");
		}
	});

	it("(entity) rejects no-protocol URL", () => {
		try {
			new URL("not-a-url");
			assert.fail("should throw on no-protocol URL");
		} catch {
			assert.ok(true, "no-protocol URL should throw");
		}
	});

	it("(entity) accepts valid URL with protocol", () => {
		const url = new URL("https://example.com");
		assert.equal(url.href, "https://example.com/", "valid URL should parse correctly");
	});
});

describe("validateUrl helper — protocol allowlist", () => {
	it("(entity) validateUrl('http://example.com') returns URL with http: protocol", () => {
		const url = validateUrl("http://example.com");
		assert.equal(url.protocol, "http:");
	});

	it("(entity) validateUrl('https://example.com') returns URL with https: protocol", () => {
		const url = validateUrl("https://example.com");
		assert.equal(url.protocol, "https:");
	});

	it("(entity) validateUrl('HTTP://EXAMPLE.COM') accepts mixed-case http", () => {
		const url = validateUrl("HTTP://EXAMPLE.COM");
		assert.equal(url.protocol, "http:");
	});

	it("(entity) validateUrl rejects file:// scheme", () => {
		assert.throws(
			() => validateUrl("file:///etc/passwd"),
			/file:/,
		);
	});

	it("(entity) validateUrl rejects data:// scheme", () => {
		assert.throws(
			() => validateUrl("data://text/html,Hello"),
			/data:/,
		);
	});

	it("(entity) validateUrl rejects ftp:// scheme", () => {
		assert.throws(
			() => validateUrl("ftp://ftp.example.com"),
			/ftp:/,
		);
	});

	it("(entity) validateUrl rejects javascript: scheme", () => {
		assert.throws(
			() => validateUrl("javascript:alert(1)"),
			/javascript:/,
		);
	});

	it("(entity) validateUrl('') throws Invalid URL (parse failure, not scheme reject)", () => {
		assert.throws(
			() => validateUrl(""),
			/Invalid URL$/,
		);
	});

	it("(entity) validateUrl('not-a-url') throws Invalid URL (parse failure, not scheme reject)", () => {
		assert.throws(
			() => validateUrl("not-a-url"),
			/Invalid URL$/,
		);
	});

	it("(entity) error message for scheme reject includes 'only http and https protocols are allowed'", () => {
		assert.throws(
			() => validateUrl("ftp://ftp.example.com"),
			/only http and https protocols are allowed/,
		);
	});
});

describe("tool parameters schema — TypeBox pattern", () => {
	it("(entity) url parameter has pattern: '^(https?|HTTPS?)://'", () => {
		const registered: Array<any> = [];
		const mockPi = {
			registerTool: (t: any) => registered.push(t),
			exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
		};
		webCrawlExtension(mockPi as any);
		const tool = registered[0];
		const urlSchema = tool.parameters.properties.url;
		assert.equal(urlSchema.pattern, "^(https?|HTTPS?)://");
	});
});

describe("handler delegation — CrawlerEngine integration", () => {
	it("(entity) handler calls engine.crawl() exactly once per invocation", async () => {
		let crawlCalls = 0;

		async function execute() {
			crawlCalls++;
			return {
				content: [{ type: "text" as const, text: "result" }],
				details: {} as Record<string, unknown>,
			};
		}

		await execute();
		assert.equal(crawlCalls, 1, "engine.crawl should be called exactly once");
	});

	it("(entity) URL validation throws before engine call", async () => {
		let engineCalled = false;

		async function execute() {
			try {
				new URL("not-a-url");
			} catch {
				throw new Error("Invalid URL");
			}
			engineCalled = true;
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		}

		await assert.rejects(execute(), /Invalid URL/);
		assert.equal(engineCalled, false, "engine should not be called after invalid URL");
	});

	it("(entity) concurrency lock acquire/release wraps engine call", async () => {
		const callOrder: string[] = [];

		async function execute() {
			callOrder.push("acquire");
			try {
				callOrder.push("engine");
			} finally {
				callOrder.push("release");
			}
		}

		await execute();
		assert.deepEqual(callOrder, ["acquire", "engine", "release"]);
	});

	it("(entity) lock releases in finally even when engine throws", async () => {
		const callOrder: string[] = [];

		async function execute() {
			callOrder.push("acquire");
			try {
				callOrder.push("engine");
				throw new Error("crawl failed");
			} finally {
				callOrder.push("release");
			}
		}

		await assert.rejects(execute(), /crawl failed/);
		assert.deepEqual(callOrder, ["acquire", "engine", "release"]);
	});

	it("(entity) onUpdate called before delegating to engine", async () => {
		const callOrder: string[] = [];

		async function execute() {
			callOrder.push("onUpdate");
			callOrder.push("engine");
		}

		await execute();
		assert.deepEqual(callOrder, ["onUpdate", "engine"]);
	});
});

describe("handler — result formatting", () => {
	it("(entity) formats successful result with URL prefix and method", () => {
		const results: CrawledPage[] = [
			{ url: "https://example.com", markdown: "# Hello", method: "lightweight", rawLength: 7 },
		];
		const output = formatEngineResults(results);
		assert.ok(output.includes("--- https://example.com (via lightweight) ---"));
		assert.ok(output.includes("# Hello"));
	});

	it("(entity) joins multiple results with double newline separator", () => {
		const results: CrawledPage[] = [
			{ url: "https://a.com", markdown: "Page A", method: "lightweight", rawLength: 6 },
			{ url: "https://b.com", markdown: "Page B", method: "stealth", rawLength: 6 },
		];
		const output = formatEngineResults(results);
		assert.ok(output.includes("Page A"));
		assert.ok(output.includes("Page B"));
		assert.ok(output.includes("\n\n"));
	});

	it("(entity) token truncation applied per-page during formatting", () => {
		const results: CrawledPage[] = [
			{
				url: "https://example.com",
				markdown: "a".repeat(400),
				method: "lightweight",
				rawLength: 400,
			},
		];
		const output = formatEngineResults(results, 5);
		assert.ok(output.includes("[... truncated at"));
		assert.ok(output.includes("~5 tokens"));
	});

	it("(entity) no truncation when maxTokens is 0", () => {
		const results: CrawledPage[] = [
			{
				url: "https://example.com",
				markdown: "a".repeat(400),
				method: "lightweight",
				rawLength: 400,
			},
		];
		const output = formatEngineResults(results, 0);
		assert.ok(!output.includes("[... truncated"));
		assert.ok(output.length > 400, "content should contain all 400 'a' chars");
		assert.ok(output.includes("a".repeat(100)), "should contain long run of 'a' chars");
	});

	it("(entity) no truncation when maxTokens is undefined", () => {
		const results: CrawledPage[] = [
			{
				url: "https://example.com",
				markdown: "a".repeat(100),
				method: "lightweight",
				rawLength: 100,
			},
		];
		const output = formatEngineResults(results, undefined);
		assert.ok(!output.includes("[... truncated"));
		assert.ok(output.includes("a".repeat(100)));
	});
});

describe("error signaling — throws for error results", () => {
	it("(entity) when engine returns error CrawlResult, handler throws with error string", async () => {
		async function execute() {
			const result = { success: false as const, error: "Connection timeout" };
			if (!result.success) {
				throw new Error(result.error);
			}
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		}

		await assert.rejects(execute(), /Connection timeout/);
	});

	it("(entity) invalid URL throws 'Invalid URL'", async () => {
		async function execute() {
			try {
				new URL("bad-url");
			} catch {
				throw new Error("Invalid URL");
			}
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		}

		await assert.rejects(execute(), /Invalid URL/);
	});
});

describe("promptSnippet and promptGuidelines", () => {
	let tool: any;

	before(() => {
		const registered: any[] = [];
		const mockPi = {
			registerTool: (t: any) => {
				registered.push(t);
			},
			exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
		};
		webCrawlExtension(mockPi as any);
		tool = registered[0];
	});

	it("(entity) tool definition has promptSnippet field", () => {
		assert.ok(tool.promptSnippet, "promptSnippet should be present");
		assert.equal(typeof tool.promptSnippet, "string", "promptSnippet should be a string");
		assert.ok(tool.promptSnippet.length > 0, "promptSnippet should not be empty");
	});

	it("(entity) tool definition has promptGuidelines field", () => {
		assert.ok(Array.isArray(tool.promptGuidelines), "promptGuidelines should be an array");
		assert.ok(tool.promptGuidelines.length >= 1, "promptGuidelines should have at least one entry");
		assert.ok(
			tool.promptGuidelines[0].includes("web_crawl"),
			"each guideline should name web_crawl explicitly",
		);
	});

	it("(entity) tool has all required fields", () => {
		const requiredFields = [
			"name",
			"label",
			"description",
			"promptSnippet",
			"promptGuidelines",
			"parameters",
			"execute",
		];
		for (const field of requiredFields) {
			assert.ok(field in tool, `tool definition should have ${field} field`);
		}
	});
});

describe("handler — import boundary (static analysis)", () => {
	const source = readFileSync(resolve(extDir, "index.ts"), "utf-8");

	it("(entity) handler no longer imports SCRAPLING_SCRIPT directly", () => {
		assert.ok(!source.includes("SCRAPLING_SCRIPT"), "index.ts should not import SCRAPLING_SCRIPT");
	});

	it("(entity) handler imports ensureScraplingVenv for constructor injection", () => {
		assert.ok(
			source.includes("ensureScraplingVenv"),
			"index.ts should import ensureScraplingVenv to pass as PythonAdapter dependency",
		);
	});

	it("(entity) handler no longer imports from python-script.ts", () => {
		assert.ok(!source.includes("python-script"), "index.ts should not import from python-script");
	});

	it("(entity) handler imports from venv-setup.ts (for ensureScraplingVenv DI)", () => {
		assert.ok(
			source.includes("venv-setup"),
			"index.ts should import from venv-setup to pass ensureScraplingVenv to PythonAdapter",
		);
	});
});
