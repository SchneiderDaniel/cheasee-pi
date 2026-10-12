/**
 * scrapling python-adapter — separation of concerns, truncation flags and the
 * web_crawl browser-provisioning user journey (#1986).
 *
 * Split from python-adapter.test.ts (issue #2005 Long File refactor).
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecFn, CrawlResult } from "../types.ts";
import { PythonAdapter } from "../python-adapter.ts";
import { ensureScraplingVenv } from "../venv-setup.ts";
import { setupTest } from "./python-adapter-fixtures.ts";

// ── Tests ──

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
			killed: false,
		});
		const exec = mock.fn(execFn);
		const adapter = new PythonAdapter(exec, "/tmp", undefined, customEnsure);
		await adapter.crawl({ url: "https://example.com", maxPages: 1 });
		assert.ok(ensureCalled, "custom ensureVenv should be called");
	});
});

describe("PythonAdapter — truncation flag + attempt counts", () => {
	const LONG = "a".repeat(400); // ~100 tokens at 4 chars/token

	function renderStdout(results: unknown[]): string {
		return JSON.stringify({ ok: true, results });
	}

	it("(entity) maxTokens undefined → truncated false", async () => {
		const { adapter } = setupTest(
			renderStdout([{ url: "https://a.com", markdown: LONG, method: "lightweight", success: true }]),
		);
		const result = await adapter.crawl({ url: "https://a.com", maxPages: 1 });
		assert.ok(result.success);
		if (result.success) assert.equal(result.results[0].truncated, false);
	});

	it("(entity) maxTokens: 0 → truncated false (passthrough)", async () => {
		const { adapter } = setupTest(
			renderStdout([{ url: "https://a.com", markdown: LONG, method: "lightweight", success: true }]),
		);
		const result = await adapter.crawl({ url: "https://a.com", maxPages: 1, maxTokens: 0 });
		assert.ok(result.success);
		if (result.success) assert.equal(result.results[0].truncated, false);
	});

	it("(entity) small maxTokens + long markdown → truncated true with suffix and preserved rawLength", async () => {
		const { adapter } = setupTest(
			renderStdout([{ url: "https://a.com", markdown: LONG, method: "lightweight", success: true }]),
		);
		const result = await adapter.crawl({ url: "https://a.com", maxPages: 1, maxTokens: 5 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(result.results[0].truncated, true);
			assert.ok(result.results[0].markdown.includes("[... truncated at"));
			assert.equal(result.results[0].rawLength, LONG.length);
		}
	});

	it("(entity) maxTokens ≥ content estimate → truncated false", async () => {
		const { adapter } = setupTest(
			renderStdout([{ url: "https://a.com", markdown: "short", method: "lightweight", success: true }]),
		);
		const result = await adapter.crawl({ url: "https://a.com", maxPages: 1, maxTokens: 1000 });
		assert.ok(result.success);
		if (result.success) assert.equal(result.results[0].truncated, false);
	});

	it("(entity) attempted counts successes + failures; failed carries per-URL errors", async () => {
		const { adapter } = setupTest(
			renderStdout([
				{ url: "https://a.com", markdown: "A", method: "lightweight", success: true },
				{ url: "https://b.com", error: "Timeout", success: false },
			]),
		);
		const result = await adapter.crawl({ url: "https://a.com", maxPages: 2 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(result.results.length, 1);
			assert.equal(result.attempted, 2);
			assert.deepEqual(result.failed, ["Timeout"]);
		}
	});

	it("(entity) absent per-result fields → truncated defaults false, no throw", async () => {
		const { adapter } = setupTest(renderStdout([{ url: "https://a.com", markdown: "x" }]));
		const result = await adapter.crawl({ url: "https://a.com", maxPages: 1 });
		assert.ok(result.success);
		if (result.success) {
			assert.equal(result.results[0].truncated, false);
			assert.equal(result.attempted, 1);
		}
	});
});

// ══════════════════════════════════════════════════════════════════════
//  User journey: web_crawl over the real provisioning stack (#1986)
// ══════════════════════════════════════════════════════════════════════

/**
 * Real PythonAdapter + real ensureScraplingVenv (ensureVenv + browser gate) over
 * a mock exec modelling the container image. The failure this pins: a browser
 * cache the agent cannot use must surface as a fast, actionable error — never as
 * a repeated ~8-minute `patchright install` block.
 */
describe("web_crawl user journey — browser provisioning contract", () => {
	interface JourneyExec {
		exec: ExecFn;
		calls: Array<{ cmd: string; args: string[] }>;
	}

	/** Mock exec modelling the fixed image: healthy venv, patchright rev 1234. */
	function imageExec(): JourneyExec {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const exec: ExecFn = async (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd.includes("bin/python3") && args[0] === "-c") {
				// The crawl call carries `-c <script> <configJSON>`; the small in-process
				// probes are 2-arg `-c <script>` calls.
				if (args.length >= 3) {
					return {
						code: 0,
						stdout: JSON.stringify({
							ok: true,
							results: [
								{
									url: "https://example.com",
									markdown: "# Crawled page",
									method: "stealth",
									success: true,
								},
							],
						}),
						stderr: "",
						killed: false,
					};
				}
				const script = args[1] ?? "";
				if (script.includes("browsers.json")) {
					return { code: 0, stdout: "1234\n", stderr: "", killed: false };
				}
				return { code: 0, stdout: "ok", stderr: "", killed: false };
			}
			return {
				code: 1,
				stdout: "",
				stderr: `mock: unexpected ${cmd} ${args.join(" ")}`,
				killed: false,
			};
		};
		return { exec, calls };
	}

	function installCalls(calls: Array<{ cmd: string; args: string[] }>) {
		return calls.filter((c) => c.args[0] === "-m" && c.args[1] === "patchright");
	}

	function useCacheRoot(root: string): () => void {
		const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
		process.env.PLAYWRIGHT_BROWSERS_PATH = root;
		return () => {
			if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
			else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
		};
	}

	it("(user-journey) fixed image: crawl succeeds with a page and issues no install subprocess", async () => {
		const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "image-cache-"));
		fs.mkdirSync(path.join(cacheRoot, "chromium-1234", "chrome-linux64"), { recursive: true });
		fs.writeFileSync(path.join(cacheRoot, "chromium-1234", "chrome-linux64", "chrome"), "");
		const restore = useCacheRoot(cacheRoot);
		try {
			const { exec, calls } = imageExec();
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "image-cwd-"));
			const adapter = new PythonAdapter(exec, cwd, undefined, ensureScraplingVenv);

			const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });

			assert.ok(result.success, `crawl should succeed: ${JSON.stringify(result)}`);
			if (result.success) {
				assert.equal(result.results[0].markdown, "# Crawled page");
				assert.equal(result.results[0].method, "stealth");
			}
			assert.equal(installCalls(calls).length, 0, "no browser install on a prepared image");
		} finally {
			restore();
		}
	});

	it("(user-journey) broken image (chromium-1243 only, cache not writable): fast actionable error, no install", async () => {
		const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "image-cache-"));
		fs.mkdirSync(path.join(cacheRoot, "chromium-1243", "chrome-linux64"), { recursive: true });
		fs.writeFileSync(path.join(cacheRoot, "chromium-1243", "chrome-linux64", "chrome"), "");
		const restore = useCacheRoot(cacheRoot);
		try {
			const { exec, calls } = imageExec();
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "image-cwd-"));
			// isWritable seam: a root CI runner cannot be made to fail access(W_OK).
			const adapter = new PythonAdapter(exec, cwd, undefined, (e, c, onUpdate) =>
				ensureScraplingVenv(e, c, onUpdate, { cacheRoot, isWritable: () => false }),
			);

			const result = await adapter.crawl({ url: "https://example.com", maxPages: 1 });

			assert.equal(result.success, false, "a mismatched browser must not be reported as success");
			if (!result.success) {
				assert.ok(result.error.includes("1234"), `error must name the expected revision: ${result.error}`);
				assert.ok(result.error.includes(cacheRoot), `error must name the cache root: ${result.error}`);
			}
			assert.equal(
				installCalls(calls).length,
				0,
				"a non-writable cache must never start the ~8-minute install",
			);
		} finally {
			restore();
		}
	});
});
