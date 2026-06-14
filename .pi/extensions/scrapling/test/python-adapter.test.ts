/**
 * Tests for python-adapter.ts — PythonAdapter subprocess orchestration
 *
 * Layer: entity — injects mock ensureVenv + mock exec, no real Python.
 * Uses the makeMockExec pattern from venv-setup-scrapling.test.ts for routing.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecFn, CrawlResult } from "../types.ts";
import { PythonAdapter } from "../python-adapter.ts";

// ── Helpers ──

/**
 * Mock ensureVenv that returns a Python path without setting up anything.
 * Injected as the 4th constructor arg to bypass venv creation in tests.
 */
async function mockEnsureVenv(_exec: ExecFn, cwd: string): Promise<string> {
	return `${cwd}/.pi/scrapling-venv/bin/python3`;
}

interface SetupTestResult {
	cwd: string;
	exec: ReturnType<typeof mock.fn<ExecFn>>;
}

/**
 * Create temp dir + wrapped mock exec + PythonAdapter with mock ensureVenv.
 *
 * @param crawlStdout - What the subprocess stdout should return (defaults to valid crawl JSON)
 * @param crawlCode - Exit code for the subprocess (default 0)
 * @returns { cwd, exec, adapter }
 */
function setupTest(
	crawlStdout?: string,
	crawlCode = 0,
): SetupTestResult & { adapter: PythonAdapter } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "python-adapter-test-"));
	const execFn: ExecFn = async (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
		return {
			code: crawlCode,
			stdout:
				crawlStdout ??
				JSON.stringify({
					ok: true,
					results: [
						{
							url: "https://example.com",
							markdown: "# Hello World",
							method: "lightweight",
							success: true,
						},
					],
				}),
			stderr: crawlCode !== 0 ? "Crawl process failed" : "",
		};
	};
	const exec = mock.fn(execFn) as ReturnType<typeof mock.fn<ExecFn>>;
	const adapter = new PythonAdapter(exec, cwd, undefined, mockEnsureVenv);
	return { cwd, exec, adapter };
}

// ── Tests ──

describe("PythonAdapter — subprocess orchestration", () => {
	it("(entity) crawl() calls exec with args array (no shell)", async () => {
		const { exec, adapter } = setupTest();
		await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.equal(exec.mock.calls.length, 1, "should call exec exactly once");
		const [cmd, args] = exec.mock.calls[0].arguments;
		assert.ok(cmd.includes("venv/bin/python3"), "cmd should be venv python3 path");
		assert.equal(args[0], "-c", "first arg should be -c");
		assert.equal(args.length, 3, "should have 3 args: -c, script, config");
		// args[1] is SCRAPLING_SCRIPT — verify it's a non-empty string
		assert.ok(
			typeof args[1] === "string" && args[1].length > 100,
			"args[1] should be SCRAPLING_SCRIPT",
		);
		// args[2] is config JSON
		const config = JSON.parse(args[2] as string);
		assert.equal(config.url, "https://example.com");
		assert.equal(config.maxPages, 1);
	});

	it("(entity) passes url, maxPages, maxTokens in config JSON", async () => {
		const { exec, adapter } = setupTest();
		await adapter.crawl({ url: "https://example.com", maxPages: 3, maxTokens: 500 });
		const [, args] = exec.mock.calls[0].arguments;
		const config = JSON.parse(args[2] as string);
		assert.equal(config.url, "https://example.com");
		assert.equal(config.maxPages, 3);
		assert.equal(config.maxTokens, 500);
	});

	it("(entity) passes maxBuffer option to exec", async () => {
		const { exec, adapter } = setupTest();
		await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		const [, , opts] = exec.mock.calls[0].arguments;
		assert.ok(opts, "should pass options to exec");
		assert.equal((opts as Record<string, unknown>).timeout, 120_000, "should set timeout");
		assert.ok((opts as Record<string, unknown>).maxBuffer !== undefined, "should set maxBuffer");
		assert.ok(
			((opts as Record<string, unknown>).maxBuffer! as number) >= 1024 * 1024,
			"maxBuffer should be at least 1MB",
		);
	});

	it("(entity) propagates AbortSignal to exec options", async () => {
		const { exec, adapter } = setupTest();
		const controller = new AbortController();
		await adapter.crawl({
			url: "https://example.com",
			maxPages: 1,
			signal: controller.signal,
		});
		const [, , opts] = exec.mock.calls[0].arguments;
		assert.equal(
			(opts as Record<string, unknown>).signal,
			controller.signal,
			"signal should be passed to exec",
		);
	});

	it("(entity) parses successful JSON output into CrawlResult", async () => {
		const { adapter } = setupTest();
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.ok(result.success, "should return success");
		if (result.success) {
			assert.equal(result.results.length, 1, "should have 1 page result");
			assert.equal(result.results[0].url, "https://example.com");
			assert.equal(result.results[0].markdown, "# Hello World");
			assert.equal(result.results[0].method, "lightweight");
		}
	});

	it("(entity) sets rawLength to original markdown string length before truncation", async () => {
		const { adapter } = setupTest();
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1, maxTokens: 0 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(result.results[0].rawLength, "# Hello World".length);
		}
	});

	it("(entity) returns totalTokens sum from raw lengths", async () => {
		const stdout = JSON.stringify({
			ok: true,
			results: [
				{ url: "https://a.com", markdown: "Hello", method: "lightweight", success: true },
				{ url: "https://b.com", markdown: "World Test", method: "stealth", success: true },
			],
		});
		const { adapter } = setupTest(stdout);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 2 });
		assert.ok(result.success);
		if (result.success) {
			// "Hello" = 5 chars → 1 token, "World Test" = 11 chars → 3 tokens, total = 4
			const expectedTokens = Math.round(5 / 4) + Math.round(11 / 4);
			assert.equal(result.totalTokens, expectedTokens);
		}
	});
});

describe("PythonAdapter — token truncation", () => {
	const LONG_CONTENT = "a".repeat(400); // ~100 tokens at 4-char/token

	function makeStdout(markdown: string): string {
		return JSON.stringify({
			ok: true,
			results: [{ url: "https://example.com", markdown, method: "lightweight", success: true }],
		});
	}

	it("(entity) maxTokens: 0 disables truncation (passthrough)", async () => {
		const { adapter } = setupTest(makeStdout(LONG_CONTENT));
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1, maxTokens: 0 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(
				result.results[0].markdown,
				LONG_CONTENT,
				"should not truncate when maxTokens is 0",
			);
			assert.equal(result.results[0].rawLength, LONG_CONTENT.length);
		}
	});

	it("(entity) undefined maxTokens disables truncation (passthrough)", async () => {
		const { adapter } = setupTest(makeStdout(LONG_CONTENT));
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(
				result.results[0].markdown,
				LONG_CONTENT,
				"should not truncate when maxTokens is undefined",
			);
		}
	});

	it("(entity) token truncation respects maxTokens param with 4-char/token estimate", async () => {
		const { adapter } = setupTest(makeStdout(LONG_CONTENT));
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1, maxTokens: 5 });
		assert.ok(result.success);
		if (result.success) {
			const content = result.results[0].markdown;
			assert.ok(content.length < LONG_CONTENT.length, "should truncate content");
			assert.ok(content.includes("[... truncated at"), "should include truncation notice");
			// 5 tokens * 4 chars/token = 20 chars max, plus suffix
			assert.ok(content.length < LONG_CONTENT.length, "truncated content should be shorter");
		}
	});

	it("(entity) sets rawLength to original length before truncation", async () => {
		const { adapter } = setupTest(makeStdout(LONG_CONTENT));
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1, maxTokens: 5 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(
				result.results[0].rawLength,
				LONG_CONTENT.length,
				"rawLength should be original length",
			);
			assert.ok(
				result.results[0].markdown.length < LONG_CONTENT.length,
				"content should be shorter after truncation",
			);
		}
	});
});

describe("PythonAdapter — error handling", () => {
	it("(entity) non-zero exit code returns error CrawlResult, does not throw", async () => {
		const { adapter } = setupTest("error output", 1);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.equal(result.success, false, "should return error result");
		if (!result.success) {
			assert.ok(result.error.length > 0, "error should have message");
		}
	});

	it("(entity) non-zero exit code includes stderr in error message", async () => {
		const { adapter } = setupTest("", 1);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.equal(result.success, false);
		if (!result.success) {
			assert.ok(
				result.error.includes("Crawl process failed"),
				"error should include stderr content",
			);
		}
	});

	it("(entity) invalid JSON stdout returns error CrawlResult, does not throw", async () => {
		const { adapter } = setupTest("not valid json{{{", 0);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.equal(result.success, false, "should return error for invalid JSON");
		if (!result.success) {
			assert.ok(
				result.error.toLowerCase().includes("parse") || result.error.includes("JSON"),
				"error should mention JSON parse failure",
			);
		}
	});

	it("(entity) missing ok/results fields returns error CrawlResult", async () => {
		const { adapter } = setupTest(JSON.stringify({ unexpected: true }), 0);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.equal(result.success, false, "should return error for unexpected format");
		if (!result.success) {
			assert.ok(
				result.error.includes("ok") || result.error.includes("results"),
				"error should mention missing fields",
			);
		}
	});

	it("(entity) timeout/abort error returns error CrawlResult", async () => {
		const { adapter } = setupTest();
		// Simulate exec throwing on abort
		const execFn: ExecFn = async () => {
			throw new Error("The operation was aborted");
		};
		const exec = mock.fn(execFn);
		const abortAdapter = new PythonAdapter(exec, "/tmp", undefined, mockEnsureVenv);
		const result = await abortAdapter.crawl({
			url: "https://example.com",
			maxPages: 1,
		});
		assert.equal(result.success, false);
		if (!result.success) {
			assert.ok(result.error.length > 0, "error should have message");
		}
	});

	it("(entity) results with success: false are skipped (not included in pages)", async () => {
		const stdout = JSON.stringify({
			ok: true,
			results: [
				{ url: "https://a.com", markdown: "Page A", method: "lightweight", success: true },
				{ url: "https://b.com", error: "Failed", success: false },
			],
		});
		const { adapter } = setupTest(stdout, 0);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 2 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(result.results.length, 1, "should skip failed results");
			assert.equal(result.results[0].url, "https://a.com");
		}
	});

	it("(entity) when all results fail, returns error CrawlResult", async () => {
		const stdout = JSON.stringify({
			ok: true,
			results: [
				{ url: "https://a.com", error: "Timeout", success: false },
				{ url: "https://b.com", error: "DNS fail", success: false },
			],
		});
		const { adapter } = setupTest(stdout, 0);
		const result = await adapter.crawl({ url: "https://example.com", maxPages: 2 });
		assert.equal(result.success, false, "should return error when all pages fail");
		if (!result.success) {
			assert.ok(
				result.error.includes("Timeout") || result.error.includes("DNS"),
				"error should collect individual errors",
			);
		}
	});
});

describe("PythonAdapter — separation of concerns", () => {
	it("(entity) does NOT acquire/release concurrency lock (handler owns that)", () => {
		// Verify by checking adapter source doesn't reference activeCrawls or semaphore
		const source = fs.readFileSync(new URL("../python-adapter.ts", import.meta.url), "utf-8");
		assert.ok(
			!source.includes("activeCrawls"),
			"PythonAdapter should not reference concurrency lock",
		);
		assert.ok(!source.includes("acquireCrawlLock"), "PythonAdapter should not acquire crawl lock");
		assert.ok(
			!source.includes("MAX_CONCURRENT_CRAWLS"),
			"PythonAdapter should not define concurrency limits",
		);
	});

	it("(entity) does NOT do URL validation (handler owns that)", () => {
		const source = fs.readFileSync(new URL("../python-adapter.ts", import.meta.url), "utf-8");
		assert.ok(!source.includes("new URL("), "PythonAdapter should not do URL validation");
	});

	it("(entity) does NOT format output for LLM (handler owns that)", () => {
		const source = fs.readFileSync(new URL("../python-adapter.ts", import.meta.url), "utf-8");
		assert.ok(
			!source.includes("(via ") && !source.includes("---"),
			"PythonAdapter should not add LLM formatting prefixes",
		);
	});

	it("(entity) ensureVenv is injectable via constructor", async () => {
		let ensureCalled = false;
		const customEnsure = async (_exec: ExecFn, _cwd: string) => {
			ensureCalled = true;
			return "/fake/python3";
		};
		const execFn: ExecFn = async () => ({
			code: 0,
			stdout: JSON.stringify({ ok: true, results: [] }),
			stderr: "",
		});
		const exec = mock.fn(execFn);
		const adapter = new PythonAdapter(exec, "/tmp", undefined, customEnsure);
		await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.ok(ensureCalled, "custom ensureVenv should be called");
	});
});
