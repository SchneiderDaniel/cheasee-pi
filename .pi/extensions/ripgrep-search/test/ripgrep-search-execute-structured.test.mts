/**
 * Tests for Ripgrep Search (ripgrep literal text search)
 *
 * Pure function tests import from .pi/extensions/ripgrep-search/ modules
 * instead of maintaining inline copies (avoids divergence risk).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ripgrep-search/test/ripgrep-search.test.mts
 *
 * Integration test runs real rg against .pi/extensions/ripgrep-search/test/fixtures/ripgrep-sample/
 * (skipped if rg binary not installed).
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import { RipgrepSearchOutputSchema } from "../types.ts";
import { parseVimgrepOutput, parseGrepOutput } from "../backends.ts";
import { buildStructuredSummary, buildSearchErrorText, renderResultImpl } from "../index.ts";
import { setTestCtxMode } from "../internal.ts";
import { clearCache, resultCache } from "../internal.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// Split from ripgrep-search.test.mts (issue #2035 Long File refactor).
describe("execute — structuredContent + annotations (Issue 1791)", () => {
	const tuiTheme = {
		fg: (_k: string, s: string) => `<${_k}>${s}</${_k}>`,
		bold: (s: string) => `*${s}*`,
	} as any;

	const HAPPY_STDOUT = Array.from({ length: 3 }, (_, i) => `src/a.ts:${i + 1}:match ${i + 1}`).join(
		"\n",
	);

	// vimgrep output (file:line:column:text) — the rg backend's parse format.
	const VIMGREP_STDOUT = [
		"src/a.ts:1:5:match 1",
		"src/a.ts:2:7:match 2",
		"src/b.ts:3:1:match 3",
	].join("\n");

	let tmpCwd: string;
	let tool: any;
	let searchExecCount: number;
	let failCode: number | null;
	let noMatch: boolean;
	// Non-null enables the ripgrep backend: `rg --version` reports success and the
	// rg search exec returns this vimgrep stdout instead of the grep-shaped output.
	let rgVimgrepStdout: string | null;

	function makeMockPi() {
		const handlers = new Map<string, Function>();
		let captured: any;
		const exec = async (command: string, args: string[] = []) => {
			if (command === "rg" && args.includes("--version")) {
				return rgVimgrepStdout
					? { code: 0, stdout: "ripgrep 14.0.0\n", stderr: "" }
					: { code: 1, stdout: "", stderr: "" };
			}
			searchExecCount++;
			if (failCode !== null) return { code: failCode, stdout: "", stderr: "boom" };
			if (noMatch) return { code: 1, stdout: "", stderr: "" };
			if (command === "rg") return { code: 0, stdout: rgVimgrepStdout ?? HAPPY_STDOUT, stderr: "" };
			return { code: 0, stdout: HAPPY_STDOUT, stderr: "" };
		};
		const pi = {
			on: (e: string, h: Function) => handlers.set(e, h),
			registerTool: (t: any) => {
				captured = t;
			},
			exec,
		};
		return { pi, getTool: () => captured };
	}

	function writeSettings(cwd: string, backend: string) {
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ search: { searchBackend: backend } }),
		);
	}

	function call(): Promise<any> {
		return tool.execute("tc", { query: "TODO", directory: "src" }, undefined, undefined, {
			cwd: tmpCwd,
		});
	}

	beforeEach(async () => {
		clearCache();
		searchExecCount = 0;
		failCode = null;
		noMatch = false;
		rgVimgrepStdout = null;
		tmpCwd = mkdtempSync(join(tmpdir(), "pi-rg-structured-"));
		mkdirSync(join(tmpCwd, ".pi"));
		writeSettings(tmpCwd, "grep");
		mkdirSync(join(tmpCwd, "src"));
		const { pi, getTool } = makeMockPi();
		const { default: ripgrepSearch } = await import("../index.ts");
		ripgrepSearch(pi as any);
		tool = getTool();
	});

	afterEach(() => {
		clearCache();
		setTestCtxMode(undefined);
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	it("happy path — structuredContent validates and content text is unchanged", async () => {
		const r = await call();
		assert.ok(Value.Check(RipgrepSearchOutputSchema, r.structuredContent));
		assert.strictEqual(r.structuredContent.total_returned, 3);
		assert.strictEqual(r.structuredContent.results[1].text, "match 2");
		assert.notStrictEqual(r.isError, true);

		const parsed = parseGrepOutput(HAPPY_STDOUT, 500);
		const expected = buildStructuredSummary(parsed, "grep", "TODO", "src", 10);
		assert.strictEqual(r.content[0].text, expected.text);
	});

	it("ripgrep happy path — `rg --version` succeeds, vimgrep output validates, content unchanged", async () => {
		writeSettings(tmpCwd, "ripgrep");
		rgVimgrepStdout = VIMGREP_STDOUT;
		const r = await call();
		assert.ok(Value.Check(RipgrepSearchOutputSchema, r.structuredContent));
		assert.strictEqual(r.structuredContent.searcher, "ripgrep");
		assert.strictEqual(r.structuredContent.total_returned, 3);
		assert.strictEqual(r.structuredContent.results[1].text, "match 2");
		assert.strictEqual(r.structuredContent.results[1].column, 7);
		assert.notStrictEqual(r.isError, true);

		const parsed = parseVimgrepOutput(VIMGREP_STDOUT, 500);
		const expected = buildStructuredSummary(parsed, "ripgrep", "TODO", "src", 10);
		assert.strictEqual(r.content[0].text, expected.text);
	});

	it("no-match (exit 1) — zero result fields, content unchanged, not an error", async () => {
		noMatch = true;
		const r = await call();
		assert.ok(Value.Check(RipgrepSearchOutputSchema, r.structuredContent));
		assert.strictEqual(r.structuredContent.total_returned, 0);
		assert.deepStrictEqual(r.structuredContent.results, []);
		assert.strictEqual(r.structuredContent.truncated, false);
		assert.ok(r.content[0].text.startsWith("No matches found"));
		assert.strictEqual(r.details.success, true);
		assert.notStrictEqual(r.isError, true);
	});

	it("cache-hit — structuredContent rebuilt from request scope, exec runs once", async () => {
		await call();
		const r2 = await call();
		assert.strictEqual(searchExecCount, 1, "second call must be served from cache");
		assert.ok(Value.Check(RipgrepSearchOutputSchema, r2.structuredContent));
		assert.strictEqual(r2.structuredContent.query, "TODO");
		assert.strictEqual(r2.structuredContent.directory, "src");
		assert.strictEqual(r2.structuredContent.searcher, "grep");
		assert.strictEqual(r2.structuredContent.total_returned, 3);
	});

	it("error path resolves with isError + structured stderr; cache not poisoned", async () => {
		failCode = 2;
		const r = await call();
		assert.strictEqual(r.isError, true);
		assert.ok(Value.Check(RipgrepSearchOutputSchema, r.structuredContent));
		assert.ok(r.structuredContent.error.includes("boom"));
		assert.strictEqual(r.structuredContent.code, 2);
		assert.strictEqual(r.structuredContent.total_returned, 0);
		assert.deepStrictEqual(r.structuredContent.results, []);
		assert.strictEqual(r.structuredContent.truncated, false);
		assert.strictEqual(
			r.content[0].text,
			buildSearchErrorText("grep", 2, undefined, "boom", "grep", "src"),
		);
		assert.strictEqual(r.details.success, false);
		assert.strictEqual(resultCache.size, 0);
	});

	it("renderResultImpl on the error result surfaces the error text (TUI)", async () => {
		failCode = 2;
		setTestCtxMode("tui");
		const r = await call();
		const rendered = renderResultImpl(r, { expanded: false }, tuiTheme, undefined);
		assert.ok((rendered as any).text.includes("boom"));
	});

	it("registration declares outputSchema + read-only/idempotent/closed-world hints", () => {
		assert.strictEqual(tool.outputSchema, RipgrepSearchOutputSchema);
		assert.deepStrictEqual(tool.annotations, {
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("parameters unchanged — query required, directory/max_count optional", () => {
		assert.ok(Value.Check(tool.parameters, { query: "x" }));
		assert.ok(Value.Check(tool.parameters, { query: "x", directory: "src", max_count: 5 }));
		assert.ok(!Value.Check(tool.parameters, {}));
		assert.ok(!Value.Check(tool.parameters, { directory: "src" }));
	});

	it("precondition failures still throw — validateQuery", async () => {
		await assert.rejects(
			() => tool.execute("tc", { query: "class User" }, undefined, undefined, { cwd: tmpCwd }),
			/structural_search/,
		);
	});

	it("precondition failures still throw — verifyDirectory", async () => {
		await assert.rejects(
			() =>
				tool.execute("tc", { query: "TODO", directory: "nope_xyz" }, undefined, undefined, {
					cwd: tmpCwd,
				}),
			/not found/,
		);
	});

	it("precondition failures still throw — resolveBackend (ripgrep required, unavailable)", async () => {
		writeSettings(tmpCwd, "ripgrep");
		const savedPath = process.env.PATH;
		const savedHome = process.env.HOME;
		process.env.PATH = "";
		process.env.HOME = tmpCwd; // no ~/.pi/agent/bin/rg under this home
		try {
			await assert.rejects(() => call(), /ripgrep not found on PATH/);
		} finally {
			process.env.PATH = savedPath;
			process.env.HOME = savedHome;
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Cache invalidation on tool_result (Issue 1900)
// ═══════════════════════════════════════════════════════════════════
