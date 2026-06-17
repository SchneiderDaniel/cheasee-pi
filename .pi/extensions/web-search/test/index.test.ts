/**
 * Tests for index.ts — tool registration, parameter validation, cache, result formatting
 *
 * Layer: (D) Domain/Unit — mock pi.exec, no network.
 * Tests the real webSearch implementation with mocked pi.exec.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecFn, ExecResult } from "../types.ts";
import webSearch, { formatResults } from "../index.ts";

// ── Mock exec helpers ──

/** Return the same ExecResult for every call */
function mockExecReturns(result: ExecResult): ExecFn {
	return async () => result;
}

/** Return ExecResults in sequence, repeating the last result for extra calls */
function mockExecSequence(results: ExecResult[]): ExecFn {
	let i = 0;
	return async () =>
		results[i++] ?? results[results.length - 1] ?? { code: 0, stdout: "", stderr: "" };
}

// ── Test helper: register the real webSearch tool with a mock pi.exec ──

interface MockPi {
	registerTool: (tool: any) => void;
	exec: ExecFn;
}

function registerWebSearch(mockExec: ExecFn): any {
	let tool: any;
	const mockPi: MockPi = {
		registerTool: (t: any) => {
			tool = t;
		},
		exec: mockExec,
	};
	webSearch(mockPi as any);
	return tool;
}

/** Temp directory for test cwds so ensureVenv can create .pi/. */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-search-test-"));
const tmp = (name: string) => path.join(tmpDir, name);

// ===========================================================================
// Module exports
// ===========================================================================

describe("webSearch module exports", () => {
	it("(D) exports webSearch as a function", () => {
		assert.equal(typeof webSearch, "function");
	});

	it("(D) exports formatResults as a function", () => {
		assert.equal(typeof formatResults, "function");
	});
});

// ===========================================================================
// Registration metadata
// ===========================================================================

describe("web-search extension entry point", () => {
	it("(D) registers web_search tool on pi.registerTool", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.equal(tool.name, "web_search");
	});

	it("(D) registered tool has execute function", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.equal(typeof tool.execute, "function");
	});

	it("(D) registered tool has query and optional maxResults parameters", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.ok(tool.parameters.properties?.query !== undefined);
		assert.ok(tool.parameters.properties?.maxResults !== undefined);
	});

	it("(D) registered tool has name, label, description fields", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.equal(tool.name, "web_search");
		assert.equal(tool.label, "Web Search");
		assert.ok(typeof tool.description === "string");
		assert.ok(tool.description.length > 20);
	});

	it("(D) registered tool has promptSnippet field", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.ok(typeof tool.promptSnippet === "string");
		assert.ok(tool.promptSnippet.toLowerCase().includes("search"));
	});

	it("(D) registered tool includes promptGuidelines array", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.ok(Array.isArray(tool.promptGuidelines));
		assert.ok(tool.promptGuidelines.length > 0);
		assert.ok(tool.promptGuidelines.every((g: any) => typeof g === "string"));
	});
});

// ===========================================================================
// execute — parameter validation (no exec calls needed, checks throw)
// ===========================================================================

describe("web_search.execute — parameter validation", () => {
	it("(D) execute validates query parameter — empty query throws error", async () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		await assert.rejects(
			tool.execute("call1", { query: "" }, undefined, undefined, { cwd: tmp("empty") }),
			{ message: "Search query is empty" },
		);
	});

	it("(D) execute validates query parameter — whitespace-only query throws error", async () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		await assert.rejects(
			tool.execute("call1", { query: "   " }, undefined, undefined, { cwd: tmp("ws") }),
			{ message: "Search query is empty" },
		);
	});
});

// ===========================================================================
// execute — error paths requiring exec mocking
// ===========================================================================

describe("web_search.execute — error paths with exec mocking", () => {
	it("(D) execute throws on venv setup failure", async () => {
		// All exec calls return code 1 → ensureVenv throws EnsureVenvError at create step
		const tool = registerWebSearch(mockExecReturns({ code: 1, stdout: "", stderr: "no python3" }));
		await assert.rejects(
			tool.execute("call1", { query: "venv-test" }, undefined, undefined, {
				cwd: tmp("venv-fail"),
			}),
			{ name: "EnsureVenvError" },
		);
	});

	it("(D) execute throws on search script non-zero exit", async () => {
		// Calls: 1=ensureVenv verify check (passes), 2=bash search script (fail)
		const tool = registerWebSearch(
			mockExecSequence([
				{ code: 0, stdout: "ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "search error" },
			]),
		);
		await assert.rejects(
			tool.execute("call1", { query: "search-test" }, undefined, undefined, {
				cwd: "/test-search-fail",
			}),
			{ message: /Search failed: python3 error/ },
		);
	});

	it("(D) execute throws on parse failure", async () => {
		// Calls: 1=ensureVenv verify check (passes), 2=bash search script (unparseable)
		const tool = registerWebSearch(
			mockExecSequence([
				{ code: 0, stdout: "ok", stderr: "" },
				{ code: 0, stdout: "no delimiters here", stderr: "" },
			]),
		);
		await assert.rejects(
			tool.execute("call1", { query: "parse-test" }, undefined, undefined, {
				cwd: "/test-parse-fail",
			}),
			{ message: /Search failed/ },
		);
	});
});

// ===========================================================================
// formatResults — result formatting
// ===========================================================================

describe("formatResults — result formatting", () => {
	it("(D) formats results with rank numbers, titles as links, snippets", () => {
		const results = [
			{ title: "Result 1", url: "https://example.com/1", snippet: "First result snippet" },
			{ title: "Result 2", url: "https://example.com/2", snippet: "Second result snippet" },
		];
		assert.ok(formatResults(results).includes("1. [Result 1](https://example.com/1)"));
		assert.ok(formatResults(results).includes("First result snippet"));
		assert.ok(formatResults(results).includes("2. [Result 2](https://example.com/2)"));
		assert.ok(formatResults(results).includes("Second result snippet"));
	});

	it("(D) returns 'No results found.' for empty array", () => {
		assert.equal(formatResults([]), "No results found.");
	});

	it("(D) encodes parentheses in URL with balanced parens (Wikipedia-style)", () => {
		const results = [
			{
				title: "C (programming language)",
				url: "https://en.wikipedia.org/wiki/C_(programming_language)",
				snippet: "C is a general-purpose programming language",
			},
		];
		const output = formatResults(results);
		assert.ok(output.includes("%28programming_language%29"), "should percent-encode both parens");
		assert.ok(
			output.includes(
				"[C (programming language)](https://en.wikipedia.org/wiki/C_%28programming_language%29)",
			),
			"should produce valid markdown link with encoded URL",
		);
		assert.ok(output.includes("C is a general-purpose programming language"));
	});

	it("(D) encodes only closing paren in URL with unbalanced parens", () => {
		const results = [
			{
				title: "Example",
				url: "https://example.com/a)",
				snippet: "A URL with a closing paren",
			},
		];
		const output = formatResults(results);
		assert.ok(output.includes("%29"), "should percent-encode closing paren");
		assert.ok(
			output.includes("https://example.com/a%29"),
			"link destination should contain encoded paren",
		);
		assert.ok(output.includes("[Example]"), "title should be preserved");
	});

	it("(D) leaves URLs without parens unchanged", () => {
		const results = [
			{ title: "Normal", url: "https://example.com/normal", snippet: "No parens here" },
		];
		const output = formatResults(results);
		assert.ok(
			output.includes("[Normal](https://example.com/normal)"),
			"URL without parens should be unchanged",
		);
	});

	it("(D) encodes multiple results independently, some with parens some without", () => {
		const results = [
			{ title: "Normal", url: "https://example.com/normal", snippet: "First" },
			{
				title: "Wiki",
				url: "https://en.wikipedia.org/wiki/Foo_(bar)",
				snippet: "Second",
			},
			{ title: "Plain", url: "https://example.org/end", snippet: "Third" },
		];
		const output = formatResults(results);
		// First result unchanged
		assert.ok(output.includes("[Normal](https://example.com/normal)"));
		// Second result encoded
		assert.ok(output.includes("https://en.wikipedia.org/wiki/Foo_%28bar%29"));
		assert.ok(!output.includes("https://en.wikipedia.org/wiki/Foo_(bar)"));
		// Third result unchanged
		assert.ok(output.includes("[Plain](https://example.org/end)"));
		// All snippets present
		assert.ok(output.includes("First"));
		assert.ok(output.includes("Second"));
		assert.ok(output.includes("Third"));
	});

	it("(D) does not double-encode already percent-encoded parens", () => {
		const results = [
			{
				title: "Pre-encoded",
				url: "https://example.com/foo%28bar%29",
				snippet: "Already encoded",
			},
		];
		const output = formatResults(results);
		// %28 and %29 should remain as-is (no raw ( or ) to match in .replace())
		assert.ok(output.includes("https://example.com/foo%28bar%29"));
		assert.ok(!output.includes("%2528") && !output.includes("%2529"), "should not double-encode");
	});
});

// ===========================================================================
// Cache functionality
// ===========================================================================

describe("Cache functionality", () => {
	it("(D) cache stores results and returns cached on repeated call", async () => {
		let callCount = 0;
		const mockExec: ExecFn = async () => {
			callCount++;
			if (callCount === 1) return { code: 0, stdout: "ok", stderr: "" };
			// Search script succeeds with valid output (matches python-script.ts format)
			const searchResults = [
				{ title: "Cached", url: "https://example.com", snippet: "Cached result" },
			];
			return {
				code: 0,
				stdout: `SEARCH_OK\n${JSON.stringify({ ok: true, results: searchResults })}\nSEARCH_DONE`,
				stderr: "",
			};
		};

		const tool = registerWebSearch(mockExec);

		// First call — should succeed and populate cache
		const result1 = await tool.execute("call1", { query: "cache-test" }, undefined, undefined, {
			cwd: tmp("cache-test"),
		});
		assert.equal(
			result1.content[0].text,
			formatResults([{ title: "Cached", url: "https://example.com", snippet: "Cached result" }]),
		);

		// Second call with same query — should use cache, no additional exec calls
		const result2 = await tool.execute("call2", { query: "cache-test" }, undefined, undefined, {
			cwd: tmp("cache-test"),
		});
		assert.equal(result2.content[0].text, result1.content[0].text);
		// First call: verify check + search script = 2. Second call: cache hit, 0 additional.
		assert.equal(callCount, 2);
	});
});
