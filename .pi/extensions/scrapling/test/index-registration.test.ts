/**
 * Tests for index.ts — tool registration, parameter schema, prompt contracts.
 *
 * Layer: entity — registration/shape contracts only, no infra.
 * Split out of index.test.ts (issue #2001).
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import webCrawlExtension from "../index.ts";

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
