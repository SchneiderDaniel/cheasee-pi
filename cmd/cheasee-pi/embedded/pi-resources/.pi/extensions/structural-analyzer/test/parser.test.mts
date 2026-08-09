/**
 * Tests: parser.ts — NDJSON parsing & exec interpretation
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { parseSgOutput, interpretSgExecResult } from "../parser.ts";

function createMatchJson(file: string, lines: string, text: string): string {
	return JSON.stringify({ file, lines, text });
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
