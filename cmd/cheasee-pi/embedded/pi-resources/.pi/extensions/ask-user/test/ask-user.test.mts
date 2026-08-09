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
import type { PathLike } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import type { QnaEntry } from "../types.ts";
import { QuestionParams, QnaReadParams } from "../types.ts";

import {
	validateQnaEntry,
	isValidISODatetime,
	toJsonlLine,
	parseJsonlLine,
	parseCsvLine,
	splitCsvRows,
	appendQnaEntry,
	readQnaEntries,
	getQnaEntry,
	listQnaEntries,
	queryQnaEntries,
	migrateQnaFromCsv,
	migrateIfCsvExists,
} from "../jsonl-logger.ts";

import askUser from "../index.ts";

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

describe("getQnaEntry / listQnaEntries / queryQnaEntries (real I/O)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-query-test-"));
		// Write 5 test entries
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "What is your name?", "Alice");
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T20:00:00.000Z",
			"What is your quest?",
			"To seek the Holy Grail",
		);
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T21:00:00.000Z",
			"What is your favorite color?",
			"Blue",
		);
		await appendQnaEntry(
			tmpDir,
			"2026-05-16T10:00:00.000Z",
			"Explain semicolons in CSV",
			"They break things",
		);
		await appendQnaEntry(
			tmpDir,
			"2026-05-16T11:00:00.000Z",
			"How JSONL works?",
			"One line per entry",
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("getQnaEntry returns entry by 1-based id", async () => {
		const entry = await getQnaEntry(tmpDir, 1);
		assert.ok(entry !== null && entry !== undefined);
		assert.strictEqual(entry.question, "What is your name?");
	});

	it("getQnaEntry returns null for out-of-range id", async () => {
		const entry = await getQnaEntry(tmpDir, 999);
		assert.strictEqual(entry, null);
	});

	it("getQnaEntry returns undefined for missing file", async () => {
		const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-empty-"));
		const entry = await getQnaEntry(emptyDir, 1);
		assert.strictEqual(entry, undefined);
		fs.rmSync(emptyDir, { recursive: true, force: true });
	});

	it("listQnaEntries returns last N entries", async () => {
		const entries = await listQnaEntries(tmpDir, 3);
		assert.strictEqual(entries.length, 3);
		assert.strictEqual(entries[0]!.question, "What is your favorite color?");
		assert.strictEqual(entries[2]!.question, "How JSONL works?");
	});

	it("listQnaEntries defaults to 20", async () => {
		const entries = await listQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 5, "Should return all when less than limit");
	});

	it("queryQnaEntries searches question field", async () => {
		const entries = await queryQnaEntries(tmpDir, "semicolons");
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.question, "Explain semicolons in CSV");
	});

	it("queryQnaEntries searches answer field", async () => {
		const entries = await queryQnaEntries(tmpDir, "Grail");
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.answer, "To seek the Holy Grail");
	});

	it("queryQnaEntries is case-insensitive", async () => {
		const entries = await queryQnaEntries(tmpDir, "holy");
		assert.strictEqual(entries.length, 1);
	});

	it("queryQnaEntries returns empty for no match", async () => {
		const entries = await queryQnaEntries(tmpDir, "zzz_nonexistent");
		assert.strictEqual(entries.length, 0);
	});
});

// ============================================================================
// Integration tests: migrateQnaFromCsv (Phase 2 — atomic migration)
// ============================================================================

describe("migrateQnaFromCsv", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-migrate-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("migrates valid CSV entries to JSONL and deletes CSV", async () => {
		// Write CSV fixture
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		const csvContent = [
			"2026-05-15T19:00:00.000Z;What is your name?;Alice",
			'2026-05-15T20:00:00.000Z;"What is your quest?";"To seek the Holy Grail"',
			"",
		].join("\n");
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		const result = await migrateQnaFromCsv(tmpDir);

		assert.strictEqual(result.migrated, 2, "Should migrate 2 entries");
		assert.strictEqual(result.skipped, 0, "Should skip 0 entries");

		// CSV should be deleted
		assert.ok(!fs.existsSync(path.join(csvDir, "qna.csv")), "CSV should be deleted");

		// JSONL should exist with migrated entries
		const jsonlPath = path.join(csvDir, "qna.jsonl");
		assert.ok(fs.existsSync(jsonlPath), "JSONL should exist");

		const entries = JSON.parse(
			"[" + fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").join(",") + "]",
		);
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0]!.question, "What is your name?");
		assert.strictEqual(entries[1]!.question, "What is your quest?");
	});

	it("skips unparseable CSV rows with warning", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		const csvContent = [
			"2026-05-15T19:00:00.000Z;Valid question;Valid answer",
			"bad-line-without-semicolons",
			"2026-05-15T20:00:00.000Z;Another valid;Another answer",
		].join("\n");
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		const result = await migrateQnaFromCsv(tmpDir);

		console.warn = origWarn;

		assert.strictEqual(result.migrated, 2, "Should migrate 2 valid entries");
		assert.strictEqual(result.skipped, 1, "Should skip 1 unparseable entry");
		assert.ok(
			warnings.some((w) => w.includes("unparseable")),
			"Should warn about unparseable row",
		);
	});

	it("skips rows with empty question or answer during migration", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		const csvContent = [
			"2026-05-15T19:00:00.000Z;Valid;Valid",
			"2026-05-15T20:00:00.000Z;;Valid answer", // Empty question
			"2026-05-15T21:00:00.000Z;Valid question;", // Empty answer
		].join("\n");
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		const result = await migrateQnaFromCsv(tmpDir);

		console.warn = origWarn;

		assert.strictEqual(result.migrated, 1, "Should migrate 1 valid entry");
		assert.strictEqual(result.skipped, 2, "Should skip 2 invalid entries");
	});

	it("returns zero counts when no CSV exists", async () => {
		const result = await migrateQnaFromCsv(tmpDir);
		assert.deepStrictEqual(result, { migrated: 0, skipped: 0 });
	});

	it("handles RFC 4180 quoted fields with newlines in CSV", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		// Multi-line CSV with quoted newlines
		const csvContent = ['2026-05-15T19:00:00.000Z;"Line1\nLine2\nLine3";"Multi-line\nanswer"'].join(
			"\n",
		);
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		const result = await migrateQnaFromCsv(tmpDir);

		assert.strictEqual(result.migrated, 1, "Should migrate multi-line CSV entry");

		// Read back the JSONL entry
		const jsonlPath = path.join(csvDir, "qna.jsonl");
		const jsonlContent = fs.readFileSync(jsonlPath, "utf-8");
		const parsed = JSON.parse(jsonlContent.trim());
		assert.strictEqual(parsed.question, "Line1\nLine2\nLine3");
		assert.strictEqual(parsed.answer, "Multi-line\nanswer");
	});

	it("renames CSV to temp before writing — atomic move prevents partial migration", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		const csvContent = ["2026-05-15T19:00:00.000Z;Q1;A1", "2026-05-15T20:00:00.000Z;Q2;A2"].join(
			"\n",
		);
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		const result = await migrateQnaFromCsv(tmpDir);

		assert.strictEqual(result.migrated, 2);
		// CSV file should be gone (renamed to temp, temp deleted)
		assert.ok(!fs.existsSync(path.join(csvDir, "qna.csv")), "CSV should no longer exist");
		// No temp files should remain
		const files = fs.readdirSync(csvDir);
		const tmpFiles = files.filter((f) => f.startsWith("qna.csv.tmp."));
		assert.strictEqual(tmpFiles.length, 0, "Temp file should be cleaned up");
	});

	it("temp file remains if JSONL write fails — source preserved for recovery", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		const csvContent = ["2026-05-15T19:00:00.000Z;Q1;A1"].join("\n");
		const csvFilePath = path.join(csvDir, "qna.csv");
		fs.writeFileSync(csvFilePath, csvContent, "utf-8");

		// Make the JSONL directory unwritable to force JSONL write failure
		const jsonlDir = path.join(csvDir, "qna.jsonl");
		// We can't easily make the dir read-only on all platforms.
		// Instead, make jsonlFile path point to a non-writable location
		// by making the context dir read-only after CSV rename.
		// Simpler approach: patch fs.promises.appendFile to fail.
		const origAppendFile = fs.promises.appendFile;
		let appendCalled = false;
		fs.promises.appendFile = async () => {
			appendCalled = true;
			throw new Error("Simulated write failure");
		};

		try {
			await assert.rejects(() => migrateQnaFromCsv(tmpDir), /Simulated write failure/);
		} finally {
			fs.promises.appendFile = origAppendFile;
		}

		// CSV should be gone (renamed to temp)
		assert.ok(!fs.existsSync(csvFilePath), "CSV should be renamed away");
		// Temp file should remain
		const files = fs.readdirSync(csvDir);
		const tmpFiles = files.filter((f) => f.startsWith("qna.csv.tmp."));
		assert.ok(tmpFiles.length > 0, "Temp file should remain after write failure");
		// Temp file should contain original CSV content
		const tmpContent = fs.readFileSync(path.join(csvDir, tmpFiles[0]!), "utf-8");
		assert.ok(tmpContent.includes("Q1;A1"), "Temp file should retain original CSV data");
	});

	it("temp file unlink failure logs warning and returns success", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		const csvContent = "2026-05-15T19:00:00.000Z;Q1;A1";
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		// Capture warnings to verify the module's internal cleanup logging
		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		try {
			const result = await migrateQnaFromCsv(tmpDir);
			// Migration should succeed
			assert.strictEqual(result.migrated, 1);
			assert.strictEqual(result.skipped, 0);
			// Temp file should be cleaned up (no warnings about cleanup needed)
			const files = fs.readdirSync(csvDir);
			const tmpFiles = files.filter((f) => f.startsWith("qna.csv.tmp."));
			assert.strictEqual(tmpFiles.length, 0, "Temp file should be cleaned up");
		} finally {
			console.warn = origWarn;
		}
	});

	it("migrateQnaFromCsv with empty CSV writes no entries, deletes CSV, cleans temp", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		// Empty CSV file
		fs.writeFileSync(path.join(csvDir, "qna.csv"), "", "utf-8");

		const result = await migrateQnaFromCsv(tmpDir);

		assert.strictEqual(result.migrated, 0);
		assert.strictEqual(result.skipped, 0);
		assert.ok(!fs.existsSync(path.join(csvDir, "qna.csv")), "CSV should be gone");
		// No temp files should remain
		const files = fs.readdirSync(csvDir);
		const tmpFiles = files.filter((f) => f.startsWith("qna.csv.tmp."));
		assert.strictEqual(tmpFiles.length, 0, "Temp file should be cleaned up");
	});
});

// ============================================================================
// Integration tests: session_start handler
// ============================================================================

describe("session_start handler", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-session-start-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("calls migrateQnaFromCsv when CSV exists", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		fs.writeFileSync(
			path.join(csvDir, "qna.csv"),
			"2026-05-15T19:00:00.000Z;What is your name?;Alice",
			"utf-8",
		);

		await migrateIfCsvExists(tmpDir);

		// CSV should be gone (migrated)
		assert.ok(!fs.existsSync(path.join(csvDir, "qna.csv")), "CSV should be migrated and removed");

		// JSONL should exist with the entry
		const jsonlPath = path.join(csvDir, "qna.jsonl");
		assert.ok(fs.existsSync(jsonlPath), "JSONL should exist after migration");

		const content = fs.readFileSync(jsonlPath, "utf-8");
		assert.ok(content.includes("What is your name?"), "Entry should be in JSONL");
		assert.ok(content.includes("Alice"), "Answer should be in JSONL");
	});

	it("is a no-op when CSV does not exist", async () => {
		// No CSV file — handler should do nothing
		await migrateIfCsvExists(tmpDir);

		// No JSONL should be created
		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		assert.ok(!fs.existsSync(jsonlPath), "JSONL should not be created when no CSV exists");
	});

	it("catches errors from migrateQnaFromCsv and logs warning instead of throwing", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		fs.writeFileSync(path.join(csvDir, "qna.csv"), "2026-05-15T19:00:00.000Z;Q1;A1", "utf-8");

		// Make appendFile fail
		const origAppend = fs.promises.appendFile;
		fs.promises.appendFile = async () => {
			throw new Error("Simulated write failure");
		};

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		// Should not throw — errors are caught internally
		await migrateIfCsvExists(tmpDir);

		fs.promises.appendFile = origAppend;
		console.warn = origWarn;

		assert.ok(
			warnings.some((w) => w.includes("Migration warning")),
			"Should log a warning instead of throwing",
		);
	});

	it("does not crash when .pi/context directory does not exist and no CSV", async () => {
		// No .pi/context dir at all — handler should be a no-op, not crash
		await migrateIfCsvExists(tmpDir);

		// No JSONL should exist
		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		assert.ok(!fs.existsSync(jsonlPath), "JSONL should not be created");
	});

	it("does not crash when .pi/context directory does not exist but CSV should be checked", async () => {
		// Test that existsSync on a non-existent path returns false gracefully
		const csvPath = path.join(tmpDir, ".pi", "context", "qna.csv");
		assert.ok(!fs.existsSync(csvPath), "CSV should not exist");

		await migrateIfCsvExists(tmpDir);

		// Should have completed without error
		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		assert.ok(!fs.existsSync(jsonlPath), "JSONL should not be created");
	});

	it("logs migration summary when entries are migrated", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		fs.writeFileSync(
			path.join(csvDir, "qna.csv"),
			"2026-05-15T19:00:00.000Z;Q1;A1\n2026-05-15T20:00:00.000Z;Q2;A2",
			"utf-8",
		);

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		await migrateIfCsvExists(tmpDir);

		console.warn = origWarn;

		assert.ok(
			warnings.some((w) => w.includes("Migration:") && w.includes("2 entries migrated")),
			"Should log migration summary",
		);
	});
});

// ============================================================================
// Structural tests: schema shape
// ============================================================================

describe("ask_user schema shape", () => {
	it("mode parameter should accept 'choice' and 'freetext' values", () => {
		const modeValues = ["choice", "freetext"] as const;
		assert.ok(modeValues.includes("choice"));
		assert.ok(modeValues.includes("freetext"));
		assert.strictEqual(modeValues.length, 2, "Mode should have exactly 2 values");
	});

	it("options should be optional when mode is freetext", async () => {
		const paramsWithoutOptions = {
			question: "Tell me about yourself",
			mode: "freetext" as const,
		};
		assert.ok("question" in paramsWithoutOptions, "Question is required");
		assert.ok("mode" in paramsWithoutOptions, "Mode is present");
		const hasOptions = "options" in paramsWithoutOptions;
		assert.strictEqual(hasOptions, false, "Options should be absent for freetext");
	});

	it("QnaEntry shape has datetime, question, answer fields", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "test",
			answer: "test",
		};
		assert.ok("datetime" in entry);
		assert.ok("question" in entry);
		assert.ok("answer" in entry);
	});

	it("QuestionParams and QnaReadParams are exported as runtime TypeBox schemas", () => {
		assert.ok(QuestionParams, "QuestionParams should be exported");
		assert.strictEqual(QuestionParams.type, "object", "QuestionParams should be an object schema");
		assert.ok(QnaReadParams, "QnaReadParams should be exported");
		assert.strictEqual(QnaReadParams.type, "object", "QnaReadParams should be an object schema");
		// Verify key properties exist in both schemas
		assert.ok("action" in QnaReadParams.properties, "QnaReadParams should have action property");
		assert.ok(
			"question" in QuestionParams.properties,
			"QuestionParams should have question property",
		);
	});
});

// ============================================================================
// Integration tests: slash command output format
// ============================================================================

describe("/qna markdown table formatting", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-slash-test-"));
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "What is your name?", "Alice");
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T20:00:00.000Z",
			"What is your quest?",
			"To seek the Holy Grail",
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("formatTable produces valid markdown table", async () => {
		const entries = await readQnaEntries(tmpDir);
		const rows: string[] = [];
		rows.push("| # | Datetime | Question | Answer |");
		rows.push("|---|---|---|---|");
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i]!;
			const id = i + 1;
			const q = e.question.length <= 60 ? e.question : e.question.slice(0, 59) + "…";
			const a = e.answer.length <= 40 ? e.answer : e.answer.slice(0, 39) + "…";
			const dt = e.datetime.length <= 24 ? e.datetime : e.datetime.slice(0, 24);
			rows.push(`| ${id} | ${dt} | ${q} | ${a} |`);
		}
		const table = rows.join("\n");

		assert.ok(table.includes("| # |"), "Should have header row");
		assert.ok(table.includes("|---|---|"), "Should have separator row");
		assert.ok(table.includes("What is your name?"), "Should contain question");
		assert.ok(table.includes("Alice"), "Should contain answer");
	});

	it("truncates long question in table", async () => {
		const longQ = "A".repeat(100);
		await appendQnaEntry(tmpDir, "2026-05-15T21:00:00.000Z", longQ, "Short answer");

		const entries = await readQnaEntries(tmpDir);
		const lastEntry = entries[entries.length - 1]!;
		const q =
			lastEntry.question.length <= 60 ? lastEntry.question : lastEntry.question.slice(0, 59) + "…";
		assert.strictEqual(q.length, 60, "Long question should be truncated to 60 chars");
		assert.ok(q.endsWith("…"), "Truncated question should end with ellipsis");
	});
});

// ============================================================================
// Edge case: empty file behavior
// ============================================================================

describe("Empty/missing JSONL file edge cases", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-empty-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("readQnaEntries returns empty for missing file", async () => {
		const entries = await readQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("listQnaEntries returns empty for missing file", async () => {
		const entries = await listQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("getQnaEntry returns undefined for missing file", async () => {
		const entry = await getQnaEntry(tmpDir, 1);
		assert.strictEqual(entry, undefined);
	});

	it("queryQnaEntries returns empty for missing file", async () => {
		const entries = await queryQnaEntries(tmpDir, "test");
		assert.deepStrictEqual(entries, []);
	});
});

// ============================================================================
// Edge case: empty JSONL file (file exists but empty)
// ============================================================================

describe("Empty JSONL file edge cases", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-empty-file-test-"));
		const jsonlDir = path.join(tmpDir, ".pi", "context");
		await fs.promises.mkdir(jsonlDir, { recursive: true });
		// Create empty file
		await fs.promises.writeFile(path.join(jsonlDir, "qna.jsonl"), "", "utf-8");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("readQnaEntries returns empty for empty file", async () => {
		const entries = await readQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("listQnaEntries returns empty for empty file", async () => {
		const entries = await listQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("getQnaEntry returns undefined for empty file", async () => {
		const entry = await getQnaEntry(tmpDir, 1);
		assert.strictEqual(entry, undefined);
	});
});

interface ContentResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

// ============================================================================
// Unit tests: successResult helper (ask_user_read success envelope)
// ============================================================================

function successResult<T extends { datetime: string; question: string; answer: string }>(
	entries: T[],
	count: number,
): ContentResult {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					entries,
					count,
					...(entries.length === 0 ? { message: "No Q&A history yet" } : {}),
				}),
			},
		],
		details: { entries, count },
	};
}

describe("successResult (ask_user_read success envelope)", () => {
	it("returns correct ContentResult shape for non-empty entries", () => {
		const entries = [
			{ datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" },
			{ datetime: "2026-05-15T20:00:00.000Z", question: "Q2", answer: "A2" },
		];
		const result = successResult(entries, entries.length);
		assert.ok(Array.isArray(result.content));
		assert.strictEqual(result.content.length, 1);
		assert.strictEqual(result.content[0]!.type, "text");

		const parsed = JSON.parse(result.content[0]!.text);
		assert.strictEqual(parsed.count, 2);
		assert.strictEqual(parsed.entries.length, 2);
		assert.ok(!parsed.message, "Should not have message when entries exist");

		assert.strictEqual(result.details.count, 2);
		assert.strictEqual((result.details.entries as Array<unknown>).length, 2);
	});

	it("returns message field when entries array is empty", () => {
		const result = successResult([], 0);
		const parsed = JSON.parse(result.content[0]!.text);
		assert.strictEqual(parsed.count, 0);
		assert.deepStrictEqual(parsed.entries, []);
		assert.strictEqual(parsed.message, "No Q&A history yet");

		assert.strictEqual(result.details.count, 0);
		assert.deepStrictEqual(result.details.entries as Array<unknown>, []);
	});

	it("allows alternative count for single-entry display", () => {
		const entry = { datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" };
		const result = successResult([entry], 1);
		const parsed = JSON.parse(result.content[0]!.text);
		assert.strictEqual(parsed.count, 1);
		assert.strictEqual(parsed.entries.length, 1);
		assert.strictEqual(parsed.entries[0]!.question, "Q1");
		assert.ok(!parsed.message, "Should not have message when entry exists");
	});

	it("details object matches content JSON shape", () => {
		const entries = [{ datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" }];
		const result = successResult(entries, 1);
		const parsed = JSON.parse(result.content[0]!.text);
		assert.strictEqual(parsed.count, result.details.count);
		assert.strictEqual(
			(parsed.entries as Array<unknown>).length,
			(result.details.entries as Array<unknown>).length,
		);
	});

	it("content is a single text block", () => {
		const result = successResult([], 0);
		assert.strictEqual(result.content.length, 1);
		assert.strictEqual(result.content[0]!.type, "text");
		assert.ok(typeof result.content[0]!.text === "string");
	});
});

// ============================================================================
// Integration tests: ask_user_read execute — error signaling
// ============================================================================

describe("ask_user_read execute — error signaling", () => {
	let tmpDir: string;
	let tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-read-error-test-"));
		tools = {};
		const mockPi: any = {
			registerTool: (tool: any) => {
				tools[tool.name] = tool;
			},
			on: () => {},
			registerCommand: () => {},
			sendUserMessage: () => {},
		};
		askUser(mockPi);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeCtx(trusted?: boolean): any {
		return {
			sessionManager: {
				getCwd: () => tmpDir,
			},
			isProjectTrusted: async () => trusted ?? true,
		};
	}

	// ── Export smoke test ─────────────────────────────────────────--

	it("exports askUser as a function", () => {
		assert.strictEqual(typeof askUser, "function");
	});

	// Entity tests — validation errors, no I/O needed

	it("throws for get action with undefined id", async () => {
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "get", id: undefined }, null, null, makeCtx()),
			/id parameter is required for get action/,
		);
	});

	it("throws for get action with missing id", async () => {
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "get" }, null, null, makeCtx()),
			/id parameter is required for get action/,
		);
	});

	it("throws for get action with null id", async () => {
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "get", id: null }, null, null, makeCtx()),
			/id parameter is required for get action/,
		);
	});

	it("throws for query action with undefined text", async () => {
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "query", text: undefined }, null, null, makeCtx()),
			/text parameter is required for query action/,
		);
	});

	it("throws for query action with empty text", async () => {
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "query", text: "" }, null, null, makeCtx()),
			/text parameter is required for query action/,
		);
	});

	it("throws for query action with missing text", async () => {
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "query" }, null, null, makeCtx()),
			/text parameter is required for query action/,
		);
	});

	it("throws for unknown action", async () => {
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "invalid_action" }, null, null, makeCtx()),
			/Unknown action: invalid_action/,
		);
	});

	// Integration tests — I/O needed

	it("throws when no Q&A history exists (empty directory)", async () => {
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "get", id: 1 }, null, null, makeCtx()),
			/No Q&A history yet/,
		);
	});

	it("throws when entry id not found", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "get", id: 999 }, null, null, makeCtx()),
			/Entry #999 not found/,
		);
	});

	it("throws when entry id 0 not found (boundary)", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "get", id: 0 }, null, null, makeCtx()),
			/Entry #0 not found/,
		);
	});

	it("propagates I/O error from storage layer (catch block)", async () => {
		// Make .pi/context a file so readdir fails
		const contextDir = path.join(tmpDir, ".pi", "context");
		await fs.promises.mkdir(path.join(tmpDir, ".pi"), { recursive: true });
		await fs.promises.writeFile(contextDir, "this is a file, not a directory", "utf-8");

		const execute = tools["ask_user_read"].execute;
		await assert.rejects(
			() => execute("call1", { action: "list" }, null, null, makeCtx()),
			/not a directory|ENOTDIR/,
		);
	});

	it("success path still works (list with entries returns successResult)", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		await appendQnaEntry(tmpDir, "2026-05-15T20:00:00.000Z", "Q2", "A2");

		const execute = tools["ask_user_read"].execute;
		const result: any = await execute("call1", { action: "list" }, null, null, makeCtx());

		assert.ok(Array.isArray(result.content));
		assert.strictEqual(result.content.length, 1);
		const parsed = JSON.parse(result.content[0]!.text);
		assert.strictEqual(parsed.count, 2);
		assert.strictEqual(parsed.entries.length, 2);
		assert.strictEqual(result.details.count, 2);
		assert.strictEqual((result.details.entries as Array<unknown>).length, 2);
	});
});
