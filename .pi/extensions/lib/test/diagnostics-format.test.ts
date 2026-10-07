/**
 * Tests for lib/diagnostics-format.ts — the single shared diagnostic renderer.
 *
 * Entity layer: pure, no I/O, no filesystem, no network.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/test/diagnostics-format.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import {
	formatDiagnostics,
	renderDiagnostics,
	pushLineBlock,
	truncateMessage,
	type FormattableDiagnostic,
} from "../diagnostics-format.ts";

interface Diag extends FormattableDiagnostic {
	code?: string | number;
}

const diag = (file: string, line: number, message: string, extra: Partial<Diag> = {}): Diag => ({
	file,
	line,
	column: 1,
	severity: "Error",
	message,
	...extra,
});

describe("truncateMessage", () => {
	it("empty message → empty string", () => {
		assert.strictEqual(truncateMessage(""), "");
	});

	it("message ≤ 500 chars → unchanged, no ... suffix", () => {
		const msg = "x".repeat(500);
		assert.strictEqual(truncateMessage(msg), msg);
	});

	it("message 501 chars → 497 chars + ...", () => {
		assert.strictEqual(truncateMessage("x".repeat(501)), "x".repeat(497) + "...");
	});

	it("message 1000 chars → length 500 ending in ...", () => {
		const result = truncateMessage("x".repeat(1000));
		assert.strictEqual(result.length, 500);
		assert.ok(result.endsWith("..."));
	});

	it("custom max → max chars total, max-3 + ...", () => {
		const result = truncateMessage("x".repeat(100), 10);
		assert.strictEqual(result.length, 10);
		assert.strictEqual(result, "x".repeat(7) + "...");
	});
});

describe("formatDiagnostics", () => {
	it("empty array → empty string", () => {
		assert.strictEqual(formatDiagnostics([]), "");
	});

	it("null / undefined → empty string", () => {
		assert.strictEqual(formatDiagnostics(null as unknown as Diag[]), "");
		assert.strictEqual(formatDiagnostics(undefined as unknown as Diag[]), "");
	});

	it("single diagnostic → one line", () => {
		assert.strictEqual(
			formatDiagnostics([diag("a.ts", 1, "type x")]),
			"a.ts, Line 1: [Error] type x",
		);
	});

	it("two files [z.ts, a.ts] → alphabetical, blank line, first block a.ts", () => {
		const result = formatDiagnostics([diag("z.ts", 1, "z"), diag("a.ts", 1, "a")]);
		assert.ok(result.startsWith("a.ts"));
		assert.ok(result.includes("\n\n"));
		assert.strictEqual(result, "a.ts, Line 1: [Error] a\n\nz.ts, Line 1: [Error] z");
	});

	it("same file lines [5,2] → line 2 first, header once, no blank line", () => {
		const result = formatDiagnostics([diag("a.ts", 5, "five"), diag("a.ts", 2, "two")]);
		const lines = result.split("\n");
		assert.strictEqual(lines[0], "a.ts, Line 2: [Error] two");
		assert.strictEqual(lines[1], "a.ts, Line 5: [Error] five");
		assert.strictEqual(lines.length, 2);
	});

	it("same line+column keeps input order (stable sort)", () => {
		const result = formatDiagnostics([
			diag("a.ts", 1, "first"),
			diag("a.ts", 1, "second"),
		]);
		assert.strictEqual(
			result,
			"a.ts, Line 1: [Error] first\na.ts, Line 1: [Error] second",
		);
	});

	it("default comparator: line asc, then column asc", () => {
		const result = formatDiagnostics([
			diag("a.ts", 2, "col9", { column: 9 }),
			diag("a.ts", 2, "col3", { column: 3 }),
			diag("a.ts", 1, "line1", { column: 7 }),
		]);
		assert.strictEqual(
			result,
			[
				"a.ts, Line 1: [Error] line1",
				"a.ts, Line 2: [Error] col3",
				"a.ts, Line 2: [Error] col9",
			].join("\n"),
		);
	});

	it("custom compare honored — severity-first beats line order", () => {
		const result = renderDiagnostics(
			[
				diag("a.ts", 1, "warn", { severity: "Warning" }),
				diag("a.ts", 9, "err", { severity: "Error" }),
			],
			{
				compare: (a, b) => {
					if (a.severity !== b.severity) return a.severity === "Error" ? -1 : 1;
					return a.line - b.line;
				},
			},
		);
		assert.strictEqual(
			result,
			"a.ts, Line 9: [Error] err\na.ts, Line 1: [Warning] warn",
		);
	});

	it("suffix callback text appended per line; empty suffix adds nothing", () => {
		const result = renderDiagnostics(
			[diag("a.ts", 1, "msg", { code: "E1" }), diag("a.ts", 2, "no code")],
			{ suffix: (d) => (d.code ? ` (${d.code})` : "") },
		);
		assert.strictEqual(
			result,
			"a.ts, Line 1: [Error] msg (E1)\na.ts, Line 2: [Error] no code",
		);
	});

	it("caller's original array order unchanged after call", () => {
		const input = [diag("z.ts", 5, "z"), diag("a.ts", 1, "a"), diag("z.ts", 1, "z2")];
		const before = input.map((d) => `${d.file}:${d.line}`);
		formatDiagnostics(input);
		assert.deepStrictEqual(
			input.map((d) => `${d.file}:${d.line}`),
			before,
		);
	});

	it("unicode/emoji message rendered verbatim", () => {
		const result = formatDiagnostics([diag("a.ts", 1, "🚀 unicode test 世界")]);
		assert.ok(result.includes("🚀 unicode test 世界"));
	});

	it("message exactly 500 inside renderer → unchanged, no ...", () => {
		const msg = "x".repeat(500);
		const result = formatDiagnostics([diag("a.ts", 1, msg)]);
		assert.strictEqual(result, `a.ts, Line 1: [Error] ${msg}`);
	});

	it("message 501 inside renderer → 500 chars ending ...", () => {
		const result = formatDiagnostics([diag("a.ts", 1, "x".repeat(501))]);
		assert.strictEqual(result, `a.ts, Line 1: [Error] ${"x".repeat(497)}...`);
	});

	it("maxMessageLength option overrides default 500", () => {
		const result = renderDiagnostics([diag("a.ts", 1, "x".repeat(100))], {
			maxMessageLength: 20,
		});
		assert.strictEqual(result, `a.ts, Line 1: [Error] ${"x".repeat(17)}...`);
	});
});

describe("pushLineBlock", () => {
	it("first block has no leading blank line", () => {
		const blocks: string[] = [];
		pushLineBlock(blocks, [diag("a.ts", 1, "one")], (d) => d.message);
		assert.deepStrictEqual(blocks, ["one"]);
	});

	it("subsequent blocks separated by exactly one blank line", () => {
		const blocks: string[] = ["one"];
		pushLineBlock(blocks, [diag("a.ts", 2, "two")], (d) => d.message);
		assert.deepStrictEqual(blocks, ["one", "", "two"]);
	});
});
