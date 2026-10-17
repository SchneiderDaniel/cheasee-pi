/**
 * Tests for .pi/extensions/ask-user/ — JSONL logging + validation + migration + query
 *
 * Tests the JSONL Q&A storage: validation, serialization, append/read/migrate/query,
 * and slash command + tool integration.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/ask-user.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import type { QnaEntry } from "../types.ts";

import {
	validateQnaEntry,
	isValidISODatetime,
	toJsonlLine,
	parseJsonlLine,
	parseCsvLine,
	appendQnaEntry,
	readQnaEntries,
} from "../jsonl-logger.ts";

// ============================================================================
// Unit tests: validateQnaEntry
// ============================================================================

describe("validateQnaEntry", () => {
	it("accepts valid entry", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "What is your name?",
			answer: "Alice",
		};
		assert.strictEqual(validateQnaEntry(entry), null);
	});

	it("rejects empty question", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "",
			answer: "Alice",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Question"));
	});

	it("rejects whitespace-only question", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "   ",
			answer: "Alice",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Question"));
	});

	it("rejects empty answer", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "What is your name?",
			answer: "",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Answer"));
	});

	it("rejects whitespace-only answer", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "What is your name?",
			answer: "   ",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Answer"));
	});

	it("rejects invalid ISO datetime", () => {
		const entry: QnaEntry = {
			datetime: "not-a-date",
			question: "What is your name?",
			answer: "Alice",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Datetime"));
	});

	it("rejects empty datetime", () => {
		const entry: QnaEntry = {
			datetime: "",
			question: "What is your name?",
			answer: "Alice",
		};
		assert.ok(validateQnaEntry(entry) !== null);
	});
});

// ============================================================================
// Unit tests: isValidISODatetime
// ============================================================================

describe("isValidISODatetime", () => {
	it("accepts ISO 8601 with Z suffix", () => {
		assert.ok(isValidISODatetime("2026-05-15T19:00:00.000Z"));
	});

	it("accepts ISO 8601 with timezone offset", () => {
		assert.ok(isValidISODatetime("2026-05-15T19:00:00+02:00"));
	});

	it("accepts ISO 8601 without timezone", () => {
		assert.ok(isValidISODatetime("2026-05-15T19:00:00"));
	});

	it("rejects non-date string", () => {
		assert.ok(!isValidISODatetime("hello"));
	});

	it("rejects empty string", () => {
		assert.ok(!isValidISODatetime(""));
	});

	it("rejects invalid date like month 13", () => {
		// new Date("2026-13-01") produces NaN
		assert.ok(!isValidISODatetime("2026-13-01"));
	});

	it("rejects overflow date like Feb 30", () => {
		// new Date("2026-02-30") silently rolls to Mar 2
		assert.ok(!isValidISODatetime("2026-02-30"));
	});

	it("rejects overflow date like Apr 31", () => {
		// new Date("2026-04-31") silently rolls to May 1
		assert.ok(!isValidISODatetime("2026-04-31"));
	});

	it("rejects overflow date with time component", () => {
		assert.ok(!isValidISODatetime("2026-02-30T19:00:00.000Z"));
	});

	it("still accepts valid leap year date 2024-02-29", () => {
		assert.ok(isValidISODatetime("2024-02-29"));
	});

	it("still accepts valid date 2026-03-01", () => {
		assert.ok(isValidISODatetime("2026-03-01"));
	});

	it("still rejects invalid month 2026-00-01", () => {
		assert.ok(!isValidISODatetime("2026-00-01"));
	});

	it("still rejects invalid day 2026-01-00", () => {
		assert.ok(!isValidISODatetime("2026-01-00"));
	});

	// ── Timezone offset edge cases (Issue #539) ───────────────────────────

	it("accepts ISO 8601 with positive timezone offset where UTC date differs", () => {
		// 2026-01-01T00:00:00+05:00 → UTC is 2025-12-31T19:00:00Z
		// Local date (Jan 1) differs from UTC date (Dec 31)
		assert.ok(isValidISODatetime("2026-01-01T00:00:00+05:00"));
	});

	it("accepts ISO 8601 with negative timezone offset where UTC date differs", () => {
		// 2026-01-01T23:00:00-05:00 → UTC is 2026-01-02T04:00:00Z
		// Local date (Jan 1) differs from UTC date (Jan 2)
		assert.ok(isValidISODatetime("2026-01-01T23:00:00-05:00"));
	});

	it("accepts ISO 8601 with timezone offset at month boundary", () => {
		// 2026-02-01T00:00:00+05:00 → UTC is 2026-01-31T19:00:00Z
		// Local date (Feb 1) differs from UTC date (Jan 31)
		assert.ok(isValidISODatetime("2026-02-01T00:00:00+05:00"));
	});

	it("accepts ISO 8601 with timezone offset at year boundary", () => {
		// 2027-01-01T00:00:00+05:00 → UTC is 2026-12-31T19:00:00Z
		assert.ok(isValidISODatetime("2027-01-01T00:00:00+05:00"));
	});

	it("accepts ISO 8601 with timezone offset and milliseconds", () => {
		assert.ok(isValidISODatetime("2026-01-01T00:00:00.123+05:00"));
	});

	it("accepts negative timezone offset without date crossing", () => {
		// 2026-05-15T10:00:00-05:00 → UTC is 2026-05-15T15:00:00Z (same date)
		assert.ok(isValidISODatetime("2026-05-15T10:00:00-05:00"));
	});

	it("accepts zero timezone offset (+00:00)", () => {
		assert.ok(isValidISODatetime("2026-05-15T19:00:00+00:00"));
	});

	it("accepts Z-suffix timezone", () => {
		assert.ok(isValidISODatetime("2026-05-15T19:00:00.000Z"));
	});

	it("still rejects overflow date Feb 30 with timezone offset", () => {
		assert.ok(!isValidISODatetime("2026-02-30T00:00:00+05:00"));
	});

	it("still rejects overflow date Apr 31 with timezone offset", () => {
		assert.ok(!isValidISODatetime("2026-04-31T12:00:00+05:00"));
	});

	it("still rejects overflow date with Z suffix", () => {
		assert.ok(!isValidISODatetime("2026-02-30T19:00:00.000Z"));
	});

	it("accepts valid leap year date 2024-02-29 with timezone offset", () => {
		assert.ok(isValidISODatetime("2024-02-29T23:00:00+05:00"));
	});

	it("accepts large positive offset like +14:00", () => {
		// +14:00 is max valid ISO 8601 timezone offset
		assert.ok(isValidISODatetime("2026-01-01T00:00:00+14:00"));
	});
});

// ============================================================================
// Unit tests: toJsonlLine / parseJsonlLine
// ============================================================================

describe("toJsonlLine", () => {
	it("produces valid JSON line with newline terminator", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "What is your name?",
			answer: "Alice",
		};
		const line = toJsonlLine(entry);
		assert.ok(line.endsWith("\n"), "Line should end with newline");
		const parsed = JSON.parse(line.trim());
		assert.strictEqual(parsed.datetime, "2026-05-15T19:00:00.000Z");
		assert.strictEqual(parsed.question, "What is your name?");
		assert.strictEqual(parsed.answer, "Alice");
	});

	it("escapes newlines in question string", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "Line1\nLine2",
			answer: "Answer",
		};
		const line = toJsonlLine(entry);
		// The line should be a single line — no actual newlines inside JSON string
		const trimmed = line.trim();
		assert.ok(!trimmed.includes("\n"), "JSONL line should not contain literal newlines");
		const parsed = JSON.parse(trimmed);
		assert.strictEqual(parsed.question, "Line1\nLine2");
	});

	it("handles special characters in question/answer", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: 'Is "this" correct?',
			answer: "Yes; it's fine",
		};
		const line = toJsonlLine(entry);
		const parsed = JSON.parse(line.trim());
		assert.strictEqual(parsed.question, 'Is "this" correct?');
		assert.strictEqual(parsed.answer, "Yes; it's fine");
	});
});

describe("parseJsonlLine", () => {
	it("parses valid JSONL line", () => {
		const line =
			'{"datetime":"2026-05-15T19:00:00.000Z","question":"What is your name?","answer":"Alice"}\n';
		const entry = parseJsonlLine(line);
		assert.ok(entry !== null);
		assert.strictEqual(entry!.datetime, "2026-05-15T19:00:00.000Z");
		assert.strictEqual(entry!.question, "What is your name?");
		assert.strictEqual(entry!.answer, "Alice");
	});

	it("returns null for empty line", () => {
		assert.strictEqual(parseJsonlLine(""), null);
		assert.strictEqual(parseJsonlLine("   "), null);
	});

	it("returns null for invalid JSON", () => {
		assert.strictEqual(parseJsonlLine("{invalid}"), null);
	});

	it("returns null for non-object JSON", () => {
		assert.strictEqual(parseJsonlLine('"just a string"'), null);
	});

	it("returns null for missing fields", () => {
		assert.strictEqual(parseJsonlLine('{"datetime":"2026-05-15T19:00:00.000Z"}'), null);
	});
});

// ============================================================================
// Unit tests: parseCsvLine (migration parsing)
// ============================================================================

describe("parseCsvLine", () => {
	it("parses simple CSV line with semicolons", () => {
		const line = "2026-05-15T19:00:00.000Z;What is your name?;Alice";
		const entry = parseCsvLine(line);
		assert.ok(entry !== null);
		assert.strictEqual(entry!.datetime, "2026-05-15T19:00:00.000Z");
		assert.strictEqual(entry!.question, "What is your name?");
		assert.strictEqual(entry!.answer, "Alice");
	});

	it("handles quoted fields with semicolons inside", () => {
		const line = '2026-05-15T19:00:00.000Z;"Pick A; B; or C";"A; definitely A"';
		const entry = parseCsvLine(line);
		assert.ok(entry !== null);
		assert.strictEqual(entry!.question, "Pick A; B; or C");
		assert.strictEqual(entry!.answer, "A; definitely A");
	});

	it("handles quoted fields with double quotes inside", () => {
		const line = '2026-05-15T19:00:00.000Z;"She said ""hello""";"He replied ""hi"""';
		const entry = parseCsvLine(line);
		assert.ok(entry !== null);
		assert.strictEqual(entry!.question, 'She said "hello"');
		assert.strictEqual(entry!.answer, 'He replied "hi"');
	});

	it("returns null for empty line", () => {
		assert.strictEqual(parseCsvLine(""), null);
	});

	it("returns null for line with no semicolons", () => {
		assert.strictEqual(parseCsvLine("just a string"), null);
	});

	it("returns null for line with only one semicolon", () => {
		assert.strictEqual(parseCsvLine("2026-05-15T19:00:00.000Z;only question"), null);
	});
});

// ============================================================================
// Integration tests: appendQnaEntry / readQnaEntries (real I/O)
// ============================================================================

describe("appendQnaEntry / readQnaEntries (real I/O)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-jsonl-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .pi/context/qna.jsonl on first write", async () => {
		const ts = "2026-05-15T19:00:00.000Z";
		await appendQnaEntry(tmpDir, ts, "What is your quest?", "To seek the Holy Grail");

		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		assert.ok(fs.existsSync(jsonlPath), "JSONL file should exist");

		const content = fs.readFileSync(jsonlPath, "utf-8");
		assert.ok(content.includes(ts), "Timestamp should be in JSONL");
		assert.ok(content.includes("What is your quest?"), "Question should be in JSONL");
		assert.ok(content.includes("To seek the Holy Grail"), "Answer should be in JSONL");
	});

	it("appends rows to existing JSONL", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		await appendQnaEntry(tmpDir, "2026-05-15T20:00:00.000Z", "Q2", "A2");

		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		const content = fs.readFileSync(jsonlPath, "utf-8");
		const lines = content.trim().split("\n");
		assert.strictEqual(lines.length, 2, "Should have exactly 2 lines");
	});

	it("stores each entry as a single JSON line", async () => {
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T19:00:00.000Z",
			"Line1\nLine2\nLine3",
			"Multi-line answer\nhere",
		);

		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		const content = fs.readFileSync(jsonlPath, "utf-8");
		const lines = content.trim().split("\n");
		assert.strictEqual(lines.length, 1, "Multi-line question should be one JSONL line");

		const parsed = JSON.parse(lines[0]!);
		assert.strictEqual(parsed.question, "Line1\nLine2\nLine3");
		assert.strictEqual(parsed.answer, "Multi-line answer\nhere");
	});

	it("rejects empty question with error", async () => {
		await assert.rejects(
			() => appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "", "Answer"),
			/Question/,
		);
	});

	it("rejects empty answer with error", async () => {
		await assert.rejects(
			() => appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Question", ""),
			/Answer/,
		);
	});

	it("rejects invalid datetime with error", async () => {
		await assert.rejects(
			() => appendQnaEntry(tmpDir, "bad-date", "Question", "Answer"),
			/Datetime/,
		);
	});

	it("readQnaEntries returns empty array for missing file", async () => {
		const entries = await readQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("readQnaEntries returns written entries", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		await appendQnaEntry(tmpDir, "2026-05-15T20:00:00.000Z", "Q2", "A2");

		const entries = await readQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0]!.question, "Q1");
		assert.strictEqual(entries[1]!.question, "Q2");
	});

	it("readQnaEntries skips corrupted lines with warning", async () => {
		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		await fs.promises.mkdir(path.dirname(jsonlPath), { recursive: true });
		// Write valid + corrupted + valid lines
		const valid1 = '{"datetime":"2026-05-15T19:00:00.000Z","question":"Q1","answer":"A1"}\n';
		const corrupted = "not-json\n";
		const valid2 = '{"datetime":"2026-05-15T20:00:00.000Z","question":"Q2","answer":"A2"}\n';
		await fs.promises.writeFile(jsonlPath, valid1 + corrupted + valid2, "utf-8");

		// Capture warnings
		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		const entries = await readQnaEntries(tmpDir);

		console.warn = origWarn;

		assert.strictEqual(entries.length, 2, "Should skip corrupted line");
		assert.ok(
			warnings.some((w) => w.includes("corrupted")),
			"Should warn about corrupted line",
		);
	});
});

// ============================================================================
// Integration tests: getQnaEntry / listQnaEntries / queryQnaEntries
// ============================================================================
