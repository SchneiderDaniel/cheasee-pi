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
import webSearch, { formatResults, buildSearchResponse } from "../index.ts";
import { WebSearchOutputSchema } from "../types.ts";
import { FRAME } from "../protocol.ts";
import { Value } from "typebox/value";

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

/** Frame a payload the way the Python producer does: <RS><json><RS> */
const framed = (payload: unknown): string => `${FRAME}${JSON.stringify(payload)}${FRAME}`;

/**
 * Mock: non-bash calls (venv verify) pass; bash is the search script. Captures the
 * script config file read at call time.
 */
function execReturning(results: Array<{ title: string; url: string; snippet: string }>): {
	exec: ExecFn;
	config: () => any;
} {
	let captured: any;
	const exec: ExecFn = async (cmd, args) => {
		if (cmd === "bash") {
			const m = args[1].match(/'([^']*config\.json)'/);
			if (m) captured = JSON.parse(fs.readFileSync(m[1], "utf-8"));
			return { code: 0, stdout: framed({ ok: true, results }), stderr: "" };
		}
		return { code: 0, stdout: "ok", stderr: "" };
	};
	return { exec, config: () => captured };
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
// Schema validation — maxResults type safety
// ===========================================================================

describe("maxResults schema validation", () => {
	it("(D) maxResults schema rejects fractional values", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		const maxResultsSchema = tool.parameters.properties.maxResults;
		// Integer values pass
		assert.ok(Value.Check(maxResultsSchema, 1));
		assert.ok(Value.Check(maxResultsSchema, 10));
		assert.ok(Value.Check(maxResultsSchema, 50));
		// Fractional values fail
		assert.equal(Value.Check(maxResultsSchema, 2.5), false);
		assert.equal(Value.Check(maxResultsSchema, 0.1), false);
		assert.equal(Value.Check(maxResultsSchema, -1.5), false);
	});

	it("(D) maxResults schema accepts the default value 10", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		const maxResultsSchema = tool.parameters.properties.maxResults;
		assert.ok(Value.Check(maxResultsSchema, 10));
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

	it("(use-case) search script non-zero exit returns isError with structured error", async () => {
		// Calls: 1=ensureVenv verify check (passes), 2=bash search script (fail)
		const tool = registerWebSearch(
			mockExecSequence([
				{ code: 0, stdout: "ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "search error" },
			]),
		);
		const result = await tool.execute("call1", { query: "search-test" }, undefined, undefined, {
			cwd: "/test-search-fail",
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Search failed: python3 error/);
		assert.deepEqual(result.structuredContent, {
			error: result.content[0].text,
			query: "search-test",
		});
	});

	it("(use-case) parse failure returns isError with structured error", async () => {
		// Calls: 1=ensureVenv verify check (passes), 2=bash search script (unparseable)
		const tool = registerWebSearch(
			mockExecSequence([
				{ code: 0, stdout: "ok", stderr: "" },
				{ code: 0, stdout: "no delimiters here", stderr: "" },
			]),
		);
		const result = await tool.execute("call1", { query: "parse-test" }, undefined, undefined, {
			cwd: "/test-parse-fail",
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Search failed/);
		assert.deepEqual(result.structuredContent, {
			error: result.content[0].text,
			query: "parse-test",
		});
	});
});

// ===========================================================================
// execute — RS framing end-to-end
// ===========================================================================

describe("web_search.execute — RS framing", () => {
	it("(use-case) framed snippet containing SEARCH_DONE resolves and is surfaced", async () => {
		const snippet = "see the SEARCH_DONE marker";
		let calls = 0;
		const mockExec: ExecFn = async () => {
			calls++;
			if (calls === 1) return { code: 0, stdout: "ok", stderr: "" };
			return {
				code: 0,
				stdout: framed({
					ok: true,
					results: [{ title: "Poisoned", url: "https://example.com", snippet }],
				}),
				stderr: "",
			};
		};
		const tool = registerWebSearch(mockExec);
		const result = await tool.execute("call1", { query: "framing-preserved" }, undefined, undefined, {
			cwd: tmp("framing-preserved"),
		});
		assert.ok(result.content[0].text.includes(snippet), "snippet must survive framing");
	});

	it("(use-case) unframed stdout returns isError with a framing error, not a SyntaxError", async () => {
		const tool = registerWebSearch(
			mockExecSequence([
				{ code: 0, stdout: "ok", stderr: "" },
				{ code: 0, stdout: 'SEARCH_OK\n{"ok":true,"results":[]}\nSEARCH_DONE', stderr: "" },
			]),
		);
		const result = await tool.execute("call1", { query: "unframed" }, undefined, undefined, {
			cwd: tmp("unframed"),
		});
		assert.equal(result.isError, true);
		const text = result.content[0].text;
		assert.ok(text.includes("Search failed:"), "should surface as Search failed");
		assert.ok(text.includes("No framed output found"), "should name the framing mismatch");
		assert.ok(!text.includes("SyntaxError"), "must not blame the JSON parser");
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
				stdout: framed({ ok: true, results: searchResults }),
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

// ===========================================================================
// Concurrency semaphore
// ===========================================================================

describe("Concurrency semaphore", () => {
	it("(entity) semaphore releases on venv failure: first call fails, second call succeeds", async () => {
		// Command-aware mock:
		// - "rm" calls succeed
		// - "python3 -m venv" calls fail (triggers EnsureVenvError step='create')
		// - python verify checks: first fails, subsequent pass quick path
		// - "bash" calls (search script): return "No results" (valid output)
		let verifyAttempts = 0;
		const mockExec: ExecFn = async (cmd: string, args: string[]) => {
			// rm call — always succeed
			if (cmd === "rm") return { code: 0, stdout: "", stderr: "" };
			// venv create call — fail to trigger EnsureVenvError
			if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
				return { code: 1, stdout: "", stderr: "venv creation failed" };
			}
			// pip install call — succeed
			if (cmd.includes("python3") && args[0] === "-m" && args[1] === "pip") {
				return { code: 0, stdout: "", stderr: "" };
			}
			// python verify check (not bash)
			if (cmd !== "bash" && args[0] === "-c") {
				verifyAttempts++;
				// First execute: verify 1 (quick check) + verify 2 (double-check) fail
				//→ goes into venv setup which fails with EnsureVenvError
				// Second execute: verify passes → quick path
				if (verifyAttempts <= 2) {
					return { code: 1, stdout: "", stderr: "import error" };
				}
				return { code: 0, stdout: "ok", stderr: "" };
			}
			// bash = search script — return empty results (valid output, becomes "No results")
			if (cmd === "bash") {
				return {
					code: 0,
					stdout: framed({ ok: true, results: [] }),
					stderr: "",
				};
			}
			// fallback
			return { code: 0, stdout: "", stderr: "" };
		};

		const tool = registerWebSearch(mockExec);

		// First call should fail with EnsureVenvError (venv create step failed)
		await assert.rejects(
			tool.execute("call1", { query: "fail-then-succeed" }, undefined, undefined, {
				cwd: tmp("semaphore-venv-fail-a"),
			}),
			{ name: "EnsureVenvError" },
		);

		// Second call should succeed — semaphore was released after first error.
		// Use different cwd so ensureVenv cache doesn't block with previous failure.
		const result = await tool.execute(
			"call2",
			{ query: "fail-then-succeed" },
			undefined,
			undefined,
			{ cwd: tmp("semaphore-venv-fail-b") },
		);
		assert.ok(result, "second call should complete without throwing");
		assert.ok(Array.isArray(result.content), "should have content array");
	});

	it("(entity) semaphore releases on search script failure: first call fails, second call succeeds", async () => {
		let bashCallCount = 0;
		const mockExec: ExecFn = async (cmd: string, args: string[]) => {
			// bash calls = search script — handle BEFORE verify check
			if (cmd === "bash") {
				bashCallCount++;
				if (bashCallCount === 1) {
					return { code: 1, stdout: "", stderr: "search script error" };
				}
				return {
					code: 0,
					stdout: framed({ ok: true, results: [{ title: "Second", url: "https://example.com", snippet: "Second attempt" }] }),
					stderr: "",
				};
			}
			// python verify check (not bash) — always pass
			if (args[0] === "-c") {
				return { code: 0, stdout: "ok", stderr: "" };
			}
			// pip install — succeed
			if (cmd.includes("python3") && args[0] === "-m" && args[1] === "pip") {
				return { code: 0, stdout: "", stderr: "" };
			}
			// All other calls — succeed
			return { code: 0, stdout: "", stderr: "" };
		};

		const tool = registerWebSearch(mockExec);

		// First call returns an error result (non-throwing)
		const first = await tool.execute("call1", { query: "search-fail" }, undefined, undefined, {
			cwd: tmp("semaphore-search-fail"),
		});
		assert.equal(first.isError, true);
		assert.match(first.content[0].text, /Search failed/);

		// Second call should succeed — semaphore was released
		const result = await tool.execute("call2", { query: "search-fail" }, undefined, undefined, {
			cwd: tmp("semaphore-search-fail"),
		});
		assert.ok(result.content[0].text.includes("Second attempt"), "second call should succeed");
	});

	it("(entity) sequential search calls: each completes independently", async () => {
		const mockExec: ExecFn = async (cmd: string, args: string[]) => {
			// bash = search script — handle BEFORE verify check
			if (cmd === "bash") {
				return {
					code: 0,
					stdout: framed({ ok: true, results: [{ title: "Seq", url: "https://example.com", snippet: "Sequential" }] }),
					stderr: "",
				};
			}
			// python verify check (not bash) — pass immediately so ensureVenv takes quick path
			if (args[0] === "-c") {
				return { code: 0, stdout: "ok", stderr: "" };
			}
			// All other calls — succeed
			return { code: 0, stdout: "", stderr: "" };
		};

		const tool = registerWebSearch(mockExec);

		// Two calls with different cwds (different cache keys), execute in parallel
		const [r1, r2] = await Promise.all([
			tool.execute("call1", { query: "sequential-test" }, undefined, undefined, {
				cwd: tmp("seq-a"),
			}),
			tool.execute("call2", { query: "sequential-test" }, undefined, undefined, {
				cwd: tmp("seq-b"),
			}),
		]);

		assert.ok(r1.content[0].text.includes("Sequential"), "first result should contain snippet");
		assert.ok(r2.content[0].text.includes("Sequential"), "second result should contain snippet");
	});

		it("(entity) cancellation during search lock wait — abort signal throws AbortError", async () => {
		// MAX_CONCURRENT_SEARCHES = 5, so we need 5 searches in-flight to fill the semaphore.
		// Gated exec: bash calls block on a deferred promise for the first 5 calls.
		let openBashGate!: () => void;
		const bashGate = new Promise<void>((r) => { openBashGate = r; });
		let bashCallCount = 0;

		const gatedExec: ExecFn = async (cmd: string, args: string[]) => {
			if (cmd === "bash") {
				bashCallCount++;
				await bashGate;
				return {
					code: 0,
					stdout: framed({ ok: true, results: [] }),
					stderr: "",
				};
			}
			// python verify check — pass for quick path
			if (args[0] === "-c") {
				return { code: 0, stdout: "ok", stderr: "" };
			}
			// pip install — succeed
			if (cmd.includes("python3") && args[0] === "-m" && args[1] === "pip") {
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const tool = registerWebSearch(gatedExec);

		// Fill 5 semaphore slots
		const cwds = Array.from({ length: 5 }, (_, i) => tmp(`cancel-fill-${i}`));
		const fillPromises = cwds.map((cwd, i) =>
			tool.execute(`fill-${i}`, { query: `fill-${i}` }, undefined, undefined, { cwd }),
		);

		// Wait for all 5 to reach bash
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(bashCallCount, 5, "all 5 semaphore slots should be occupied by bash calls");

		// 6th call with abort signal — queues in acquireSearchLock while loop
		const controller = new AbortController();
		const p6 = tool.execute("id6", { query: "cancel-6th" }, controller.signal, undefined, {
			cwd: tmp("cancel-6th"),
		});

		// Give p6 time to enter the while loop
		await new Promise((r) => setTimeout(r, 250));

		// Abort while waiting
		controller.abort();

		// p6 should reject with AbortError within 1 poll interval (~200ms for search)
		await assert.rejects(p6, { name: "AbortError" }, "abort during search lock wait should throw AbortError");

		// Clean up: release bash gate so fill searches complete
		openBashGate();
		await Promise.allSettled(fillPromises);
	});

	it("(entity) after abort during search lock wait, fresh calls still work — no semaphore corruption", async () => {
		let openBashGate!: () => void;
		const bashGate = new Promise<void>((r) => { openBashGate = r; });
		let bashCallCount = 0;

		const gatedExec: ExecFn = async (cmd: string, args: string[]) => {
			if (cmd === "bash") {
				bashCallCount++;
				await bashGate;
				return {
					code: 0,
					stdout: framed({ ok: true, results: [] }),
					stderr: "",
				};
			}
			if (args[0] === "-c") {
				return { code: 0, stdout: "ok", stderr: "" };
			}
			if (cmd.includes("python3") && args[0] === "-m" && args[1] === "pip") {
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const tool = registerWebSearch(gatedExec);

		// Fill 5 semaphore slots
		const cwds = Array.from({ length: 5 }, (_, i) => tmp(`corrupt-fill-${i}`));
		const fillPromises = cwds.map((cwd, i) =>
			tool.execute(`fill-${i}`, { query: `corrupt-q-${i}` }, undefined, undefined, { cwd }),
		);

		await new Promise((r) => setTimeout(r, 500));
		assert.equal(bashCallCount, 5, "all 5 slots occupied");

		// 6th call with abort signal
		const controller = new AbortController();
		const p6 = tool.execute("id6", { query: "corrupt-abort-6th" }, controller.signal, undefined, {
			cwd: tmp("corrupt-6th"),
		});
		await new Promise((r) => setTimeout(r, 250));
		controller.abort();
		await assert.rejects(p6, { name: "AbortError" }, "p6 aborted");

		// Release bash gate so fill searches complete, freeing all 5 slots
		openBashGate();
		await Promise.allSettled(fillPromises);

		// Fresh call should acquire immediately (no corruption)
		const fresh = tool.execute("fresh", { query: "fresh-after-abort" }, undefined, undefined, {
			cwd: tmp("fresh-after-abort"),
		});
		const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("fresh did not complete within 3s")), 3000));
		await Promise.race([fresh, timeout]);
		assert.ok(bashCallCount >= 6, "fresh call should reach bash after slots freed");
	});
});

// ===========================================================================
// Phase 1 — structured details payload (identical shape on both terminal paths)
// ===========================================================================

describe("web_search.execute — structured details payload", () => {
	it("(use-case) fresh search returns details { query, returned, results } with returned === results.length", async () => {
		const results = [
			{ title: "One", url: "https://one.example", snippet: "first" },
			{ title: "Two", url: "https://two.example", snippet: "second" },
		];
		const tool = registerWebSearch(execReturning(results).exec);
		const r = await tool.execute("c1", { query: "fresh-details" }, undefined, undefined, {
			cwd: tmp("fresh-details"),
		});
		assert.deepEqual(r.details, { query: "fresh-details", returned: 2, results });
	});

	it("(use-case) cache hit returns details identical to the fresh call", async () => {
		const results = [{ title: "Cached", url: "https://c.example", snippet: "cached" }];
		const tool = registerWebSearch(execReturning(results).exec);
		const fresh = await tool.execute("c1", { query: "deep-equal-details" }, undefined, undefined, {
			cwd: tmp("deep-equal"),
		});
		const hit = await tool.execute("c2", { query: "deep-equal-details" }, undefined, undefined, {
			cwd: tmp("deep-equal"),
		});
		assert.deepEqual(hit.details, fresh.details);
	});

	it("(use-case) details.query is trimmed and maxResults defaults to 10 in script config", async () => {
		const { exec, config } = execReturning([{ title: "T", url: "https://t.example", snippet: "s" }]);
		const tool = registerWebSearch(exec);
		await tool.execute("c1", { query: "  trimmed-query  " }, undefined, undefined, {
			cwd: tmp("trimmed"),
		});
		assert.equal(config().query, "trimmed-query");
		assert.equal(config().max_results, 10);
	});

	it("(use-case) empty results → returned 0, results [] and 'No results found.' text", async () => {
		const tool = registerWebSearch(execReturning([]).exec);
		const r = await tool.execute("c1", { query: "empty-results" }, undefined, undefined, {
			cwd: tmp("empty-results"),
		});
		assert.deepEqual(r.details, { query: "empty-results", returned: 0, results: [] });
		assert.equal(r.content[0].text, "No results found.");
	});

	it("(use-case) onUpdate carries WebSearchPayload-shaped details (query set, results [])", async () => {
		const updates: any[] = [];
		const tool = registerWebSearch(execReturning([]).exec);
		await tool.execute("c1", { query: "onupdate-shape" }, undefined, (u: any) => updates.push(u), {
			cwd: tmp("onupdate"),
		});
		const searchUpdate = updates.find((u) => u.details?.query === "onupdate-shape");
		assert.ok(searchUpdate, "search onUpdate should carry a query-tagged details payload");
		assert.equal(searchUpdate.details.returned, 0);
		assert.deepEqual(searchUpdate.details.results, []);
	});
});

describe("buildSearchResponse — single assembler", () => {
	it("(entity) content[0] is text byte-identical to formatResults(results) and details/structuredContent mirror payload", () => {
		const results = [
			{ title: "A (x)", url: "https://a.example/wiki_(x)", snippet: "alpha" },
			{ title: "B", url: "https://b.example", snippet: "beta" },
		];
		const r = buildSearchResponse("q", results);
		assert.deepEqual(r.content, [{ type: "text", text: formatResults(results) }]);
		assert.deepEqual(r.details, { query: "q", returned: 2, results });
		assert.deepEqual(r.structuredContent, r.details);
	});
});

// ===========================================================================
// outputSchema + annotations (native pi 1.0.x fields)
// ===========================================================================

describe("web_search — outputSchema & annotations", () => {
	it("(D) registered tool carries annotations { openWorldHint }", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.deepEqual(tool.annotations, { openWorldHint: true });
	});

	it("(D) registered tool carries a JSON-serializable outputSchema", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.ok(tool.outputSchema, "outputSchema should be present");
		const roundTripped = JSON.parse(JSON.stringify(tool.outputSchema));
		assert.equal(typeof roundTripped, "object");
	});

	it("(use-case) fresh and cache-hit structuredContent are identical and match outputSchema", async () => {
		const results = [{ title: "Schema", url: "https://s.example", snippet: "matched" }];
		const tool = registerWebSearch(execReturning(results).exec);
		const fresh = await tool.execute("c1", { query: "schema-match" }, undefined, undefined, {
			cwd: tmp("schema-match"),
		});
		const hit = await tool.execute("c2", { query: "schema-match" }, undefined, undefined, {
			cwd: tmp("schema-match"),
		});
		assert.deepEqual(hit.structuredContent, fresh.structuredContent);
		assert.ok(
			Value.Check(WebSearchOutputSchema, fresh.structuredContent),
			"structuredContent must validate against the declared outputSchema",
		);
	});
});
