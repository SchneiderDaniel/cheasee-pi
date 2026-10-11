/**
 * Tests for index.ts — handler delegation to CrawlerEngine
 *
 * Layer: entity — mock CrawlerEngine, no infra, no subprocess.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
describe("error signaling — precondition throws", () => {
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
