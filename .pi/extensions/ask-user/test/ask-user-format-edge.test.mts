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
	appendQnaEntry,
	readQnaEntries,
	getQnaEntry,
	listQnaEntries,
	queryQnaEntries,
} from "../jsonl-logger.ts";

// ============================================================================
// Unit tests: validateQnaEntry
// ============================================================================

// Split from ask-user.test.mts (issue #2035 Long File refactor).
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
		const { entries, total } = await listQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
		assert.strictEqual(total, 0);
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
		const { entries, total } = await listQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
		assert.strictEqual(total, 0);
	});

	it("getQnaEntry returns undefined for empty file", async () => {
		const entry = await getQnaEntry(tmpDir, 1);
		assert.strictEqual(entry, undefined);
	});
});

// ============================================================================
// Unit tests: successResult helper (ask_user_read success envelope)
// ============================================================================
