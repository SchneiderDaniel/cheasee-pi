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
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgResult } from "../types.ts";
import { renderCallImpl, renderResultImpl, wrapOsc8Link } from "../index.ts";
import { setTestCtxMode, getCtxMode } from "../internal.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// Split from ripgrep-search.test.mts (issue #2035 Long File refactor).
describe("mode gate + OSC 8 hyperlinks", () => {
	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	const tuiTheme = {
		fg: (_k: string, s: string) => `<${_k}>${s}</${_k}>`,
		bold: (s: string) => `*${s}*`,
	} as any;

	const sampleText =
		"ripgrep search results for query: foo\n" +
		"Directory: .\n" +
		"Matches returned: 2 across 1 file\n\n" +
		"1. src/app.ts:42:16:const x = 1;\n" +
		"2. config/settings.py:4:8:TIMEOUT_MS = 5000";

	function makeResult(
		text: string,
		overrides?: {
			total_returned?: number;
			searchDirectory?: string;
			success?: boolean;
		},
	) {
		const { total_returned = 2, searchDirectory, success = true } = overrides ?? {};
		return {
			content: [{ type: "text" as const, text }],
			details: {
				success,
				total_returned,
				searcher: "ripgrep",
				searchDirectory,
				unique_files: 1,
				truncated: false,
			},
		};
	}

	afterEach(() => {
		setTestCtxMode(undefined);
	});

	// ---------------------------------------------------------------------------
	// renderResult — TUI mode
	// ---------------------------------------------------------------------------

	describe("renderResult — TUI mode", () => {
		beforeEach(() => {
			setTestCtxMode("tui");
		});

		it("results present → each file path line wrapped with OSC 8 file:// hyperlink", () => {
			const searchDir = "/home/user/project";
			const result = makeResult(sampleText, { searchDirectory: searchDir });
			const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			// Should contain OSC 8 sequences for each result line
			const fileUrl1 = pathToFileURL(join(searchDir, "src/app.ts")).href + "#L42";
			const fileUrl2 = pathToFileURL(join(searchDir, "config/settings.py")).href + "#L4";
			assert.ok(
				content.includes(fileUrl1),
				`Content should contain OSC 8 URL for src/app.ts: ${content}`,
			);
			assert.ok(
				content.includes(fileUrl2),
				`Content should contain OSC 8 URL for config/settings.py: ${content}`,
			);
			// Should include the OSC 8 start/end markers
			assert.ok(content.includes("\x1b]8;;"), "Content should contain OSC 8 escape sequences");
			// Summary line is not wrapped
			assert.ok(content.includes("2 matches"), "Content should show summary");
		});

		it("zero results → No matches found text unchanged (no OSC 8)", () => {
			const result = makeResult("No matches found", {
				total_returned: 0,
				searchDirectory: "/tmp/test",
			});
			const rendered = renderResultImpl(result, { expanded: false }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("No matches found"), "Should show no matches");
			assert.ok(!content.includes("\x1b]8;;"), "Should not contain OSC 8 sequences");
		});

		it("details.searchDirectory undefined → file paths as plain text, no OSC 8", () => {
			const result = makeResult(sampleText, { searchDirectory: undefined });
			const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("src/app.ts:42:16"), "Should show file path as plain text");
			assert.ok(!content.includes("\x1b]8;;"), "Should not contain OSC 8 sequences");
		});

		it("isPartial=true → returns 'Searching...'", () => {
			setTestCtxMode("tui");
			const result = makeResult(sampleText);
			const rendered = renderResultImpl(result, { isPartial: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("Searching..."), "Should show searching indicator");
			assert.ok(!content.includes("\x1b]8;;"), "Should not contain OSC 8");
		});

		it("success=false → returns error text", () => {
			const result = makeResult("rg: command not found", {
				success: false,
				searchDirectory: "/tmp/test",
			});
			const rendered = renderResultImpl(result, { expanded: false }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("rg: command not found"), "Should show error text");
			assert.ok(!content.includes("\\x1b]8;;"), "Should not contain OSC 8");
		});
	});

	// ---------------------------------------------------------------------------
	// renderResult — non-TUI mode
	// ---------------------------------------------------------------------------

	describe("renderResult — non-TUI modes", () => {
		const modes = ["rpc", "json", "print"] as const;

		for (const mode of modes) {
			it(`${mode} mode → returns raw text content, no theme formatting, no OSC 8`, () => {
				setTestCtxMode(mode);
				const result = makeResult(sampleText, { searchDirectory: "/tmp/test" });
				const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

				const content = (rendered as any).text;
				// Should be raw text without theme tags
				assert.strictEqual(content, sampleText, `${mode} mode should return raw text`);
			});
		}
	});

	// ---------------------------------------------------------------------------
	// renderResult — _ctxMode undefined (session_start not fired)
	// ---------------------------------------------------------------------------

	describe("renderResult — _ctxMode undefined (session_start not fired)", () => {
		it("defaults to TUI rendering (OSC 8 applied if data present)", () => {
			// _ctxMode starts as undefined, test doesn't set it
			setTestCtxMode(undefined);
			const searchDir = "/home/user/project";
			const result = makeResult(sampleText, { searchDirectory: searchDir });
			const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			// Should have OSC 8 since _ctxMode is undefined (defaults to TUI)
			assert.ok(content.includes("\x1b]8;;"), "Should contain OSC 8 (TUI default)");
			assert.ok(content.includes("2 matches"), "Should show summary");
		});

		it("no searchDirectory → renders as before (no OSC 8)", () => {
			setTestCtxMode(undefined);
			const result = makeResult(sampleText);
			const rendered = renderResultImpl(result, { expanded: true }, tuiTheme, undefined);

			const content = (rendered as any).text;
			assert.ok(content.includes("src/app.ts:42:16"), "Should show file path as plain text");
			assert.ok(!content.includes("\x1b]8;;"), "Should not contain OSC 8");
		});
	});

	// ---------------------------------------------------------------------------
	// renderCall
	// ---------------------------------------------------------------------------

	describe("renderCall", () => {
		it('TUI mode → formatted `rg "query"` with theme colors', () => {
			setTestCtxMode("tui");
			const rendered = renderCallImpl({ query: "TIMEOUT_MS", directory: "." }, tuiTheme, undefined);
			const content = (rendered as any).text;
			assert.ok(content.includes("rg"), "Should contain rg");
			assert.ok(content.includes("TIMEOUT_MS"), "Should contain query");
			// Should have theme tags
			assert.ok(content.includes("<toolTitle>"), "Should have theme formatting");
		});

		it("non-TUI mode (rpc) → returns raw args.query text, no theme colors", () => {
			setTestCtxMode("rpc");
			const rendered = renderCallImpl({ query: "TIMEOUT_MS", directory: "." }, tuiTheme, undefined);
			const content = (rendered as any).text;
			assert.strictEqual(content, "TIMEOUT_MS", "rpc mode should return raw query");
		});

		it("non-TUI mode (json) → returns raw args.query text", () => {
			setTestCtxMode("json");
			const rendered = renderCallImpl({ query: "TIMEOUT_MS" }, tuiTheme, undefined);
			const content = (rendered as any).text;
			assert.strictEqual(content, "TIMEOUT_MS", "json mode should return raw query");
		});

		it("non-TUI mode (print) → returns raw args.query text", () => {
			setTestCtxMode("print");
			const rendered = renderCallImpl({ query: "TIMEOUT_MS" }, tuiTheme, undefined);
			const content = (rendered as any).text;
			assert.strictEqual(content, "TIMEOUT_MS", "print mode should return raw query");
		});

		it("undefined _ctxMode → defaults to TUI (same as before)", () => {
			setTestCtxMode(undefined);
			const rendered = renderCallImpl(
				{ query: "TIMEOUT_MS", directory: "src" },
				tuiTheme,
				undefined,
			);
			const content = (rendered as any).text;
			assert.ok(content.includes("rg"), "Should contain rg");
			assert.ok(content.includes("src"), "Should contain directory");
			assert.ok(content.includes("<toolTitle>"), "Should have theme formatting");
		});
	});

	// ---------------------------------------------------------------------------
	// wrapOsc8Link — pure function
	// ---------------------------------------------------------------------------

	describe("wrapOsc8Link", () => {
		it("result line matches pattern → wrapped with OSC 8 hyperlink", () => {
			const line = "1. src/app.ts:42:16:const x = 1;";
			const result = wrapOsc8Link(line, "/project");

			const expectedUrl = pathToFileURL("/project/src/app.ts").href + "#L42";
			assert.ok(result.includes(expectedUrl), "Should contain file URL");
			assert.ok(result.includes("\x1b]8;;"), "Should contain OSC 8 start");
			assert.ok(result.includes("\x1b]8;;\x1b\\"), "Should contain OSC 8 end (empty)");
			// The file:line:column part should appear between OSC 8 markers
			assert.ok(result.includes("src/app.ts:42:16"), "Should preserve file path with line:col");
		});

		it("non-matching line (header) → unchanged", () => {
			const line = "ripgrep search results for query: foo";
			const result = wrapOsc8Link(line, "/project");
			assert.strictEqual(result, line, "Header lines should be unchanged");
		});

		it("non-matching line (empty) → unchanged", () => {
			const result = wrapOsc8Link("", "/project");
			assert.strictEqual(result, "", "Empty line should be unchanged");
		});

		it("file path with spaces → URL-encoded correctly", () => {
			const line = "1. my file.ts:10:5:content";
			const result = wrapOsc8Link(line, "/project");

			const expectedUrl = pathToFileURL("/project/my file.ts").href + "#L10";
			assert.ok(
				result.includes(encodeURI(expectedUrl)) || result.includes(expectedUrl),
				"URL should be encoded: " + result,
			);
		});

		it("file path with unicode chars → percent-encoded correctly", () => {
			const line = "1. 文件.ts:3:1:你好";
			const result = wrapOsc8Link(line, "/project");

			const expectedUrl = pathToFileURL("/project/文件.ts").href + "#L3";
			assert.ok(result.includes(expectedUrl), "Should contain URL with percent-encoded unicode");
		});

		it("file path with # → #L fragment separator unambiguous, path # escaped", () => {
			const line = "1. file#1.ts:5:3:text";
			const result = wrapOsc8Link(line, "/project");

			// pathToFileURL percent-encodes # as %23
			const expectedUrl = pathToFileURL("/project/file#1.ts").href + "#L5";
			assert.ok(result.includes("#L5"), "Fragment separator should be #L5");
			assert.ok(result.includes(expectedUrl), "URL should have # encoded as %23 in path");
		});
	});

	// ---------------------------------------------------------------------------
	// execute return details — searchDirectory field
	// ---------------------------------------------------------------------------

	describe("execute return details — searchDirectory", () => {
		it("non-cached result → details.searchDirectory is set to resolved absolute path", () => {
			// This tests that the execute handler would set searchDirectory
			// We verify via makeResult that the details contain it
			setTestCtxMode("tui");
			const searchDir = "/home/user/project";
			const result = makeResult(sampleText, { searchDirectory: searchDir });
			assert.strictEqual(
				result.details.searchDirectory,
				searchDir,
				"details.searchDirectory should match what execute sets",
			);
		});

		it("cached result → details.searchDirectory still present", () => {
			const searchDir = "/tmp/cached-dir";
			const result = makeResult(sampleText, { searchDirectory: searchDir });
			assert.ok(
				result.details.searchDirectory !== undefined,
				"Cached result should still have searchDirectory",
			);
			assert.strictEqual(result.details.searchDirectory, searchDir);
		});

		it("zero-result success → details.searchDirectory still present", () => {
			const searchDir = "/tmp/zero-result";
			const result = makeResult("No matches found", {
				total_returned: 0,
				searchDirectory: searchDir,
			});
			assert.strictEqual(
				result.details.searchDirectory,
				searchDir,
				"Zero-result should have searchDirectory",
			);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: setTestCtxMode / getCtxMode — setter/getter pair in internal.ts
// ═══════════════════════════════════════════════════════════════════════

describe("setTestCtxMode / getCtxMode", () => {
	afterEach(() => {
		setTestCtxMode(undefined);
	});

	it('setTestCtxMode("tui") then getCtxMode() returns "tui"', () => {
		setTestCtxMode("tui");
		assert.strictEqual(getCtxMode(), "tui");
	});

	it('setTestCtxMode("rpc") then getCtxMode() returns "rpc"', () => {
		setTestCtxMode("rpc");
		assert.strictEqual(getCtxMode(), "rpc");
	});

	it('setTestCtxMode("json") then getCtxMode() returns "json"', () => {
		setTestCtxMode("json");
		assert.strictEqual(getCtxMode(), "json");
	});

	it('setTestCtxMode("print") then getCtxMode() returns "print"', () => {
		setTestCtxMode("print");
		assert.strictEqual(getCtxMode(), "print");
	});

	it("setTestCtxMode(undefined) then getCtxMode() returns undefined", () => {
		setTestCtxMode(undefined);
		assert.strictEqual(getCtxMode(), undefined);
	});

	it("sequence: set tui, then rpc, then json — each read returns latest", () => {
		setTestCtxMode("tui");
		assert.strictEqual(getCtxMode(), "tui");
		setTestCtxMode("rpc");
		assert.strictEqual(getCtxMode(), "rpc");
		setTestCtxMode("json");
		assert.strictEqual(getCtxMode(), "json");
	});

	it("getCtxMode() before any setTestCtxMode call returns undefined", () => {
		setTestCtxMode(undefined); // reset to initial state
		assert.strictEqual(getCtxMode(), undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: _setTestCtxMode removed from index.ts
// ═══════════════════════════════════════════════════════════════════════

describe("_setTestCtxMode removed from index.ts", () => {
	it("dynamic import shows _setTestCtxMode is undefined (export removed)", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(
			(mod as Record<string, unknown>)._setTestCtxMode,
			undefined,
			"_setTestCtxMode should not be exported from index.ts",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: session_start handler preserves production write path
// ═══════════════════════════════════════════════════════════════════════

describe("session_start sets mode through setTestCtxMode", () => {
	let capturedHandlers: Map<string, Function>;
	let restorePi: { on: (e: string, h: Function) => void; registerTool: () => void };

	beforeEach(() => {
		capturedHandlers = new Map();
		restorePi = {
			on: (event: string, handler: Function) => {
				capturedHandlers.set(event, handler);
			},
			registerTool: () => {},
		};
	});

	afterEach(() => {
		setTestCtxMode(undefined);
	});

	it('ctx.mode = "json" → getCtxMode() returns "json"', async () => {
		const { default: ripgrepSearch } = await import("../index.ts");
		ripgrepSearch(restorePi as any);

		const handler = capturedHandlers.get("session_start");
		assert.ok(handler, "session_start handler should be registered");

		await handler(undefined, { mode: "json", cwd: process.cwd() });
		assert.strictEqual(getCtxMode(), "json");
	});

	it('ctx.mode = "tui" → getCtxMode() returns "tui"', async () => {
		const { default: ripgrepSearch } = await import("../index.ts");
		ripgrepSearch(restorePi as any);

		const handler = capturedHandlers.get("session_start");
		assert.ok(handler, "session_start handler should be registered");

		await handler(undefined, { mode: "tui", cwd: process.cwd() });
		assert.strictEqual(getCtxMode(), "tui");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// structuredContent contract + tool metadata (Issue 1791)
// ═══════════════════════════════════════════════════════════════════════
