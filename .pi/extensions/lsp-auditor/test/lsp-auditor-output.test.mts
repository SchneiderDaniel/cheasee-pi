/**
 * Phase 4: Output-adapter module — formatForMode pure function tests
 *
 * Tests the mode-adaptive formatting of LSP diagnostics.
 * Pure functions only — no I/O, no Pi API.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lsp-auditor/test/lsp-auditor-output.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { LspDiagnostic, StructuredDiagnostics } from "../types.ts";
import { formatForMode } from "../output-adapter.ts";
import { formatDiagnostics } from "../formatting.ts";

// ─── Shared fixture — 3 diagnostics across 2 files ───────────────────

const SAMPLE_DIAGS: LspDiagnostic[] = [
	{
		file: "/workspace/src/app.ts",
		line: 10,
		column: 5,
		severity: "Error",
		message: "Type 'string' is not assignable to type 'number'",
	},
	{
		file: "/workspace/src/app.ts",
		line: 25,
		column: 1,
		severity: "Warning",
		message: "Variable 'x' is declared but never used",
	},
	{
		file: "/workspace/src/lib.ts",
		line: 3,
		column: 8,
		severity: "Error",
		message: "Cannot find name 'foo'",
	},
];

const WORKTREE_PATH = "/workspace";

// Non-alphabetical fixture — locks the accepted ordering delta (blocks become alphabetical)
const NON_ALPHA_DIAGS: LspDiagnostic[] = [
	{ file: "/workspace/z.ts", line: 1, column: 1, severity: "Error", message: "zzz" },
	{ file: "/workspace/a.ts", line: 1, column: 1, severity: "Error", message: "aaa" },
];

// Boundary fixtures for truncation tests
const EXACT_500_MSG = "x".repeat(500);
const LONG_MSG_501 = "x".repeat(501);

// =========================================================================
// Tests
// =========================================================================

describe("formatForMode — TUI mode", () => {
	it("hasUI=true returns string with file:// URIs", () => {
		const result = formatForMode(SAMPLE_DIAGS, "tui", WORKTREE_PATH, true);
		assert.strictEqual(typeof result, "string");
		assert.ok((result as string).includes("file:///workspace/src/app.ts"));
		assert.ok((result as string).includes("file:///workspace/src/lib.ts"));
	});

	it("hasUI=true includes clickable link lines for each diagnostic", () => {
		const result = formatForMode(SAMPLE_DIAGS, "tui", WORKTREE_PATH, true) as string;
		// Each diagnostic should have a line with the file URI, line, severity, and message
		assert.ok(result.includes("[Error]"));
		assert.ok(result.includes("[Warning]"));
		assert.ok(result.includes("Type 'string' is not assignable"));
		assert.ok(result.includes("Variable 'x' is declared"));
	});

	it("hasUI=false returns plain text without file:// URIs", () => {
		const result = formatForMode(SAMPLE_DIAGS, "tui", WORKTREE_PATH, false);
		assert.strictEqual(typeof result, "string");
		assert.ok(!(result as string).includes("file://"));
	});

	it("hasUI=false output matches formatDiagnostics style", () => {
		const result = formatForMode(SAMPLE_DIAGS, "tui", WORKTREE_PATH, false) as string;
		// Should contain file paths but not as URIs
		assert.ok(result.includes("/workspace/src/app.ts"));
		assert.ok(!result.includes("file://"));
	});
});

describe("formatForMode — RPC mode", () => {
	it("returns StructuredDiagnostics object", () => {
		const result = formatForMode(SAMPLE_DIAGS, "rpc", WORKTREE_PATH, false);
		assert.ok(typeof result === "object" && result !== null);
		const sd = result as StructuredDiagnostics;
		assert.ok(Array.isArray(sd.files));
	});

	it("contains files[].path and files[].issues structure", () => {
		const result = formatForMode(
			SAMPLE_DIAGS,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		assert.strictEqual(result.files.length, 2);

		const appTs = result.files.find((f) => f.path === "/workspace/src/app.ts");
		assert.ok(appTs);
		assert.strictEqual(appTs!.issues.length, 2);

		const libTs = result.files.find((f) => f.path === "/workspace/src/lib.ts");
		assert.ok(libTs);
		assert.strictEqual(libTs!.issues.length, 1);
	});

	it("issues have line, col, severity, message fields", () => {
		const result = formatForMode(
			SAMPLE_DIAGS,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		const issue = result.files[0]!.issues[0]!;
		assert.ok("line" in issue);
		assert.ok("col" in issue);
		assert.ok("severity" in issue);
		assert.ok("message" in issue);
		assert.strictEqual(typeof issue.line, "number");
		assert.strictEqual(typeof issue.col, "number");
	});

	it("serializable via JSON.stringify", () => {
		const result = formatForMode(
			SAMPLE_DIAGS,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		const serialized = JSON.stringify(result);
		assert.ok(typeof serialized === "string");
		const parsed = JSON.parse(serialized);
		assert.ok(Array.isArray(parsed.files));
	});
});

describe("formatForMode — JSON mode", () => {
	it("returns same StructuredDiagnostics shape as RPC mode", () => {
		const rpcResult = formatForMode(
			SAMPLE_DIAGS,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		const jsonResult = formatForMode(
			SAMPLE_DIAGS,
			"json",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		assert.deepStrictEqual(jsonResult, rpcResult);
	});
});

describe("formatForMode — Print mode", () => {
	it("returns plain text string matching formatDiagnostics output", () => {
		const result = formatForMode(SAMPLE_DIAGS, "print", WORKTREE_PATH, false);
		assert.strictEqual(typeof result, "string");
		// Should contain diagnostic details without file:// URIs
		assert.ok((result as string).includes("[Error]"));
		assert.ok((result as string).includes("[Warning]"));
	});

	it("no file:// URIs in output", () => {
		const result = formatForMode(SAMPLE_DIAGS, "print", WORKTREE_PATH, false) as string;
		assert.ok(!result.includes("file://"));
	});
});

describe("formatForMode — edge cases", () => {
	it("empty diagnostics array → empty string for text modes", () => {
		const tuiResult = formatForMode([], "tui", WORKTREE_PATH, true);
		assert.strictEqual(tuiResult, "");

		const printResult = formatForMode([], "print", WORKTREE_PATH, false);
		assert.strictEqual(printResult, "");
	});

	it("empty diagnostics array → empty files array for structured modes", () => {
		const rpcResult = formatForMode([], "rpc", WORKTREE_PATH, false) as StructuredDiagnostics;
		assert.deepStrictEqual(rpcResult, { files: [] });

		const jsonResult = formatForMode([], "json", WORKTREE_PATH, false) as StructuredDiagnostics;
		assert.deepStrictEqual(jsonResult, { files: [] });
	});

	it("null/undefined diagnostics → empty result, no crash", () => {
		const tuiResult = formatForMode(null as unknown as LspDiagnostic[], "tui", WORKTREE_PATH, true);
		assert.strictEqual(tuiResult, "");

		const rpcResult = formatForMode(
			undefined as unknown as LspDiagnostic[],
			"rpc",
			WORKTREE_PATH,
			false,
		);
		assert.deepStrictEqual(rpcResult, { files: [] });

		const jsonResult = formatForMode(
			null as unknown as LspDiagnostic[],
			"json",
			WORKTREE_PATH,
			false,
		);
		assert.deepStrictEqual(jsonResult, { files: [] });
	});

	it("diagnostics with unicode paths and messages → passed through unmodified", () => {
		const unicodeDiags: LspDiagnostic[] = [
			{
				file: "/workspace/测试/文件.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "🚀 unicode test 世界",
			},
		];
		const tuiResult = formatForMode(unicodeDiags, "tui", WORKTREE_PATH, true) as string;
		// TUI mode encodes file paths as URIs, so raw characters are percent-encoded
		assert.ok(tuiResult.includes("file:///workspace/%E6%B5%8B%E8%AF%95/%E6%96%87%E4%BB%B6.ts"));
		// Message text is not URI-encoded
		assert.ok(tuiResult.includes("🚀 unicode test 世界"));

		const rpcResult = formatForMode(
			unicodeDiags,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		// Structured mode uses raw paths, not URIs
		assert.ok(rpcResult.files[0]!.path.includes("测试"));
		assert.ok(rpcResult.files[0]!.issues[0]!.message.includes("🚀 unicode test 世界"));
	});

	it("unknown mode → defaults to print mode (plain text)", () => {
		const result = formatForMode(SAMPLE_DIAGS, "unknown-mode", WORKTREE_PATH, false);
		assert.strictEqual(typeof result, "string");
	});
});

describe("formatForMode — delegation to formatDiagnostics", () => {
	it("print route ≡ formatDiagnostics (exact equality)", () => {
		const result = formatForMode(SAMPLE_DIAGS, "print", WORKTREE_PATH, false) as string;
		assert.strictEqual(result, formatDiagnostics(SAMPLE_DIAGS));
	});

	it("tui + hasUI=false route ≡ formatDiagnostics (exact equality)", () => {
		const result = formatForMode(SAMPLE_DIAGS, "tui", WORKTREE_PATH, false) as string;
		assert.strictEqual(result, formatDiagnostics(SAMPLE_DIAGS));
	});

	it("unknown mode route ≡ formatDiagnostics (exact equality)", () => {
		const result = formatForMode(SAMPLE_DIAGS, "unknown-mode", WORKTREE_PATH, false) as string;
		assert.strictEqual(result, formatDiagnostics(SAMPLE_DIAGS));
	});

	it("single diagnostic → exact plain-text line", () => {
		const single = [
			{ file: "/workspace/a.ts", line: 1, column: 1, severity: "Error", message: "msg" },
		] as LspDiagnostic[];
		const result = formatForMode(single, "print", WORKTREE_PATH, false) as string;
		assert.strictEqual(result, "/workspace/a.ts, Line 1: [Error] msg");
	});

	it("same-file diagnostics sorted by line asc then column asc", () => {
		const unsorted = [
			{ file: "/workspace/a.ts", line: 5, column: 9, severity: "Warning", message: "w" },
			{ file: "/workspace/a.ts", line: 2, column: 7, severity: "Error", message: "e" },
			{ file: "/workspace/a.ts", line: 2, column: 3, severity: "Hint", message: "h" },
		] as LspDiagnostic[];
		const result = formatForMode(unsorted, "print", WORKTREE_PATH, false) as string;
		assert.strictEqual(
			result,
			[
				"/workspace/a.ts, Line 2: [Hint] h",
				"/workspace/a.ts, Line 2: [Error] e",
				"/workspace/a.ts, Line 5: [Warning] w",
			].join("\n"),
		);
	});

	it("two files → blocks separated by exactly one blank line", () => {
		const result = formatForMode(SAMPLE_DIAGS, "print", WORKTREE_PATH, false) as string;
		const appBlock = [
			"/workspace/src/app.ts, Line 10: [Error] Type 'string' is not assignable to type 'number'",
			"/workspace/src/app.ts, Line 25: [Warning] Variable 'x' is declared but never used",
		].join("\n");
		const libBlock = "/workspace/src/lib.ts, Line 3: [Error] Cannot find name 'foo'";
		assert.strictEqual(result, `${appBlock}\n\n${libBlock}`);
	});

	it("message exactly 500 chars → untruncated, no ... suffix", () => {
		const result = formatForMode(
			[{ file: "/workspace/a.ts", line: 1, column: 1, severity: "Error", message: EXACT_500_MSG }],
			"print",
			WORKTREE_PATH,
			false,
		) as string;
		assert.strictEqual(result, `/workspace/a.ts, Line 1: [Error] ${EXACT_500_MSG}`);
	});

	it("message 501 chars → exactly 497 chars + ...", () => {
		const result = formatForMode(
			[{ file: "/workspace/a.ts", line: 1, column: 1, severity: "Error", message: LONG_MSG_501 }],
			"print",
			WORKTREE_PATH,
			false,
		) as string;
		assert.strictEqual(
			result,
			`/workspace/a.ts, Line 1: [Error] ${LONG_MSG_501.slice(0, 497)}...`,
		);
	});

	it("empty message → rendered, no truncation", () => {
		const result = formatForMode(
			[{ file: "/workspace/a.ts", line: 1, column: 1, severity: "Error", message: "" }],
			"print",
			WORKTREE_PATH,
			false,
		) as string;
		assert.strictEqual(result, "/workspace/a.ts, Line 1: [Error] ");
	});

	it("same line+column pair keeps input order (stable sort)", () => {
		const samePos = [
			{ file: "/workspace/a.ts", line: 1, column: 1, severity: "Error", message: "first" },
			{ file: "/workspace/a.ts", line: 1, column: 1, severity: "Error", message: "second" },
		] as LspDiagnostic[];
		const result = formatForMode(samePos, "print", WORKTREE_PATH, false) as string;
		assert.strictEqual(
			result,
			"/workspace/a.ts, Line 1: [Error] first\n/workspace/a.ts, Line 1: [Error] second",
		);
	});

	it("non-alphabetical input [z.ts, a.ts] → first block is a.ts (alphabetical delta)", () => {
		const result = formatForMode(NON_ALPHA_DIAGS, "print", WORKTREE_PATH, false) as string;
		assert.ok(result.startsWith("/workspace/a.ts"));
		assert.strictEqual(result, formatDiagnostics(NON_ALPHA_DIAGS));
	});
});
