/**
 * Tests: parser.ts — NDJSON parsing & exec interpretation
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { parseSgOutput, interpretSgExecResult } from "../parser.ts";
import { StructuralSearchOutputSchema } from "../types.ts";

function createMatchJson(file: string, lines: string, text: string): string {
	return JSON.stringify({ file, lines, text });
}

function assertConforms(result: { structuredContent?: unknown }): void {
	assert.ok(
		Value.Check(StructuralSearchOutputSchema, result.structuredContent),
		`structuredContent does not conform to StructuralSearchOutputSchema: ${JSON.stringify(
			result.structuredContent,
		)}`,
	);
}

const TWO_MATCHES = [
	createMatchJson(
		"api/auth.py",
		"22-28",
		"try:\n    verify_token(token)\nexcept AuthError:\n    print('auth failed')",
	),
	createMatchJson("src/app.ts", "10-10", "console.log('App started')"),
].join("\n");

describe("parseSgOutput", () => {
	it("parses valid JSONL with 2 matches", () => {
		const result = parseSgOutput(TWO_MATCHES);
		assert.strictEqual(result.matches, 2);
		assert.strictEqual(result.results.length, 2);
		assert.strictEqual(result.results[0]!.file, "api/auth.py");
		assert.strictEqual(result.results[1]!.file, "src/app.ts");
	});

	it("returns empty for empty string", () => {
		const result = parseSgOutput("");
		assert.strictEqual(result.matches, 0);
		assert.strictEqual(result.results.length, 0);
	});

	it("skips malformed JSON line, still parses valid line", () => {
		const input = ["not json", createMatchJson("a.ts", "1", "ok")].join("\n");
		const result = parseSgOutput(input);
		assert.strictEqual(result.matches, 1);
		assert.strictEqual(result.results[0]!.file, "a.ts");
	});

	it("handles null/undefined input defensively", () => {
		assert.strictEqual(parseSgOutput(null as unknown as string).matches, 0);
		assert.strictEqual(parseSgOutput(undefined as unknown as string).matches, 0);
	});

	it("skips line missing file field", () => {
		const input = JSON.stringify({ lines: "1", text: "x" });
		const result = parseSgOutput(input);
		assert.strictEqual(result.matches, 0);
	});

	it("converts numeric lines field to string", () => {
		const input = JSON.stringify({ file: "a.ts", lines: 42, text: "x" });
		const result = parseSgOutput(input);
		assert.strictEqual(result.matches, 1);
		assert.strictEqual(result.results[0]!.lines, "42");
	});
});

describe("interpretSgExecResult", () => {
	it("exit code 0 with valid JSONL returns parsed content", () => {
		const result = interpretSgExecResult(0, TWO_MATCHES, "", "console.log($A)", "ts");
		assert.strictEqual(result.isError, undefined);
		assert.strictEqual(result.content[0].type, "text");
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 2);
		assert.ok(Array.isArray(details.results));
		assert.strictEqual(details.success, true);
	});

	it("exit code 0 with empty stdout returns no-match", () => {
		const result = interpretSgExecResult(0, "", "", "pat", "ts");
		assert.strictEqual(result.isError, undefined);
		assert.ok(result.content[0].text.includes("No matches found"));
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 0);
	});

	it("exit code 1 with empty stderr returns no-match (ast-grep convention)", () => {
		const result = interpretSgExecResult(1, "", "", "pat", "ts");
		assert.strictEqual(result.isError, undefined);
		assert.ok(result.content[0].text.includes("No matches found"));
	});

	it("exit code 1 with non-empty stderr returns error", () => {
		const result = interpretSgExecResult(1, "", "unknown language", "pat", "ts");
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes("unknown language"));
	});

	it("exit code 126 returns error", () => {
		const result = interpretSgExecResult(126, "", "Permission denied", "pat", "ts");
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes("126"));
	});

	it("exit code 2 returns error", () => {
		const result = interpretSgExecResult(2, "", "error", "pat", "ts");
		assert.strictEqual(result.isError, true);
	});

	it("exit code 0 with stderr (warning) returns parsed results (stdout-first defensive)", () => {
		const result = interpretSgExecResult(0, TWO_MATCHES, "warning", "pat", "ts");
		assert.strictEqual(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 2);
	});

	it("more than STREAM_THRESHOLD matches returns truncated result", () => {
		const manyMatches = Array.from({ length: 150 }, (_, i) =>
			createMatchJson(`file${i}.ts`, `${i}-${i + 1}`, `match number ${i}`),
		).join("\n");
		const result = interpretSgExecResult(0, manyMatches, "", "pat", "ts");
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.truncated, true);
		assert.strictEqual(details.totalMatches, 150);
	});
});

describe("StructuralSearchOutputSchema", () => {
	it("accepts a 2-match success shape", () => {
		assert.ok(
			Value.Check(StructuralSearchOutputSchema, {
				matches: 2,
				results: [{ file: "a.ts", lines: "1-2", snippet: "x" }],
				language: "ts",
			}),
		);
	});

	it("accepts a truncated shape", () => {
		const results = Array.from({ length: 100 }, (_, i) => ({
			file: `f${i}.ts`,
			lines: `${i}`,
			snippet: "x",
		}));
		assert.ok(
			Value.Check(StructuralSearchOutputSchema, {
				matches: 150,
				results,
				language: "ts",
				truncated: true,
				totalMatches: 150,
			}),
		);
	});

	it("accepts the error shape (one permissive object covers both)", () => {
		assert.ok(
			Value.Check(StructuralSearchOutputSchema, {
				matches: 0,
				results: [],
				language: "badlang",
				error: "unknown language",
				stderr: "unknown language",
				exitCode: 1,
				pattern: "pat",
			}),
		);
	});
});

describe("interpretSgExecResult structuredContent", () => {
	it("success branch: structuredContent mirrors parsed results", () => {
		const result = interpretSgExecResult(0, TWO_MATCHES, "", "console.log($A)", "ts");
		assertConforms(result);
		const details = result.details as Record<string, unknown>;
		assert.deepStrictEqual(result.structuredContent, {
			matches: 2,
			results: parseSgOutput(TWO_MATCHES).results,
			language: "ts",
		});
		assert.strictEqual(
			(result.structuredContent as { matches: number }).matches,
			details.matches,
		);
		assert.strictEqual(result.isError, undefined);
	});

	it("code 0 empty stdout: structuredContent is the empty shape", () => {
		const result = interpretSgExecResult(0, "", "", "pat", "ts");
		assertConforms(result);
		assert.deepStrictEqual(result.structuredContent, { matches: 0, results: [], language: "ts" });
		assert.strictEqual(result.isError, undefined);
	});

	it("code 1 empty stderr (no-match): structuredContent is the empty shape", () => {
		const result = interpretSgExecResult(1, "", "", "pat", "ts");
		assertConforms(result);
		assert.deepStrictEqual(result.structuredContent, { matches: 0, results: [], language: "ts" });
		assert.strictEqual(result.isError, undefined);
	});

	it("truncated: matches is total, results capped, truncation signaled", () => {
		const manyMatches = Array.from({ length: 150 }, (_, i) =>
			createMatchJson(`file${i}.ts`, `${i}-${i + 1}`, `match number ${i}`),
		).join("\n");
		const result = interpretSgExecResult(0, manyMatches, "", "pat", "ts");
		assertConforms(result);
		const sc = result.structuredContent as {
			matches: number;
			results: unknown[];
			truncated?: boolean;
			totalMatches?: number;
		};
		assert.strictEqual(sc.matches, 150);
		assert.strictEqual(sc.results.length, 100);
		assert.strictEqual(sc.truncated, true);
		assert.strictEqual(sc.totalMatches, 150);
	});

	it("exactly 100 matches → not truncated; 101 → truncated", () => {
		const hundred = Array.from({ length: 100 }, (_, i) =>
			createMatchJson(`file${i}.ts`, `${i}`, `m${i}`),
		).join("\n");
		const atThreshold = interpretSgExecResult(0, hundred, "", "pat", "ts");
		assertConforms(atThreshold);
		assert.strictEqual((atThreshold.structuredContent as { truncated?: boolean }).truncated, undefined);
		assert.strictEqual(
			(atThreshold.structuredContent as { results: unknown[] }).results.length,
			100,
		);

		const overThreshold = interpretSgExecResult(
			0,
			hundred + "\n" + createMatchJson("extra.ts", "1", "x"),
			"",
			"pat",
			"ts",
		);
		assertConforms(overThreshold);
		assert.strictEqual((overThreshold.structuredContent as { truncated?: boolean }).truncated, true);
		assert.strictEqual(
			(overThreshold.structuredContent as { results: unknown[] }).results.length,
			100,
		);
	});

	it("error branch: structuredContent carries error/stderr/exitCode/pattern", () => {
		const result = interpretSgExecResult(1, "", "unknown language", "pat", "badlang");
		assertConforms(result);
		assert.strictEqual(result.isError, true);
		assert.strictEqual((result.details as Record<string, unknown>).success, false);
		assert.deepStrictEqual(result.structuredContent, {
			matches: 0,
			results: [],
			language: "badlang",
			error: "unknown language",
			stderr: "unknown language",
			exitCode: 1,
			pattern: "pat",
		});
	});

	it("exit 126 error branch surfaces exitCode 126 and stderr", () => {
		const result = interpretSgExecResult(126, "", "Permission denied", "pat", "ts");
		assertConforms(result);
		const sc = result.structuredContent as { exitCode?: number; stderr?: string };
		assert.strictEqual(result.isError, true);
		assert.strictEqual(sc.exitCode, 126);
		assert.strictEqual(sc.stderr, "Permission denied");
	});

	it("exit 0 + stderr warning still yields stdout-first success structuredContent", () => {
		const result = interpretSgExecResult(0, TWO_MATCHES, "warning", "pat", "ts");
		assertConforms(result);
		assert.strictEqual(result.isError, undefined);
		assert.strictEqual((result.structuredContent as { matches: number }).matches, 2);
	});
});
