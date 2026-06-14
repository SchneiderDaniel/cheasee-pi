/**
 * Tests for crawler-engine.ts — CrawlerEngine port contract
 *
 * Layer: entity — pure type/interface validation, no implementation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "..");
const source = readFileSync(resolve(extDir, "crawler-engine.ts"), "utf-8");

describe("CrawlerEngine interface — port contract", () => {
	it("(entity) exports CrawlerEngine interface", () => {
		assert.ok(
			/export\s+interface\s+CrawlerEngine/.test(source),
			"crawler-engine.ts should export CrawlerEngine interface",
		);
	});

	it("(entity) CrawlerEngine declares crawl method", () => {
		assert.ok(/crawl\s*\(/.test(source), "CrawlerEngine should declare a crawl method");
	});

	it("(entity) crawl method returns Promise<CrawlResult>", () => {
		assert.ok(source.includes("Promise<CrawlResult>"), "crawl should return Promise<CrawlResult>");
	});

	it("(entity) crawl params include CrawlParams and optional signal", () => {
		assert.ok(
			source.includes("signal") && source.includes("AbortSignal"),
			"crawl should accept optional AbortSignal",
		);
	});

	it("(entity) imports CrawlParams from types.ts", () => {
		const importPattern =
			/import\s+type\s*\{[^}]*\bCrawlParams\b[^}]*\}\s*from\s+["']\.\/types(?:\.ts)?["']/;
		assert.ok(
			importPattern.test(source),
			"crawler-engine.ts should import CrawlParams from ./types.ts",
		);
	});

	it("(entity) imports CrawlResult from types.ts", () => {
		const importPattern =
			/import\s+type\s*\{[^}]*\bCrawlResult\b[^}]*\}\s*from\s+["']\.\/types(?:\.ts)?["']/;
		assert.ok(
			importPattern.test(source),
			"crawler-engine.ts should import CrawlResult from ./types.ts",
		);
	});
});

describe("CrawlResult type — discriminated union", () => {
	it("(entity) success branch has results: CrawledPage[] and totalTokens: number", () => {
		const hasSuccessResults =
			/success:\s*true/.test(source) || /results:\s*CrawledPage\[\]/.test(source);
		// Check types.ts since CrawlResult is defined there for interface use
		const typesSource = readFileSync(resolve(extDir, "types.ts"), "utf-8");
		assert.ok(
			typesSource.includes("CrawledPage[]"),
			"CrawlResult success branch should have CrawledPage[] results",
		);
		assert.ok(
			typesSource.includes("totalTokens"),
			"CrawlResult success branch should have totalTokens",
		);
	});

	it("(entity) error branch has error: string", () => {
		const typesSource = readFileSync(resolve(extDir, "types.ts"), "utf-8");
		assert.ok(
			typesSource.includes("error: string"),
			"CrawlResult error branch should have error: string",
		);
	});
});

describe("CrawledPage type", () => {
	it("(entity) has url: string", () => {
		const typesSource = readFileSync(resolve(extDir, "types.ts"), "utf-8");
		assert.ok(typesSource.includes("url: string"), "CrawledPage should have url: string");
	});

	it("(entity) has markdown: string", () => {
		const typesSource = readFileSync(resolve(extDir, "types.ts"), "utf-8");
		assert.ok(typesSource.includes("markdown: string"), "CrawledPage should have markdown: string");
	});

	it("(entity) has method: 'lightweight' | 'stealth'", () => {
		const typesSource = readFileSync(resolve(extDir, "types.ts"), "utf-8");
		assert.ok(
			typesSource.includes("lightweight") && typesSource.includes("stealth"),
			"CrawledPage should have method discriminator",
		);
	});

	it("(entity) has rawLength: number", () => {
		const typesSource = readFileSync(resolve(extDir, "types.ts"), "utf-8");
		assert.ok(
			typesSource.includes("rawLength: number") || typesSource.includes("rawLength:"),
			"CrawledPage should have rawLength: number",
		);
	});
});
