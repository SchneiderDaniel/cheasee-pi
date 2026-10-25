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

import { appendQnaEntry, getQnaEntry, listQnaEntries, queryQnaEntries } from "../jsonl-logger.ts";

// ============================================================================
// Unit tests: validateQnaEntry
// ============================================================================

// Split from ask-user.test.mts (issue #2035 Long File refactor).
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
		const { entries, total } = await listQnaEntries(tmpDir, 3);
		assert.strictEqual(entries.length, 3);
		assert.strictEqual(total, 5);
		assert.strictEqual(entries[0]!.question, "What is your favorite color?");
		assert.strictEqual(entries[2]!.question, "How JSONL works?");
		// Absolute ids: last 3 of 5 → 3, 4, 5
		assert.deepStrictEqual(
			entries.map((e) => e.id),
			[3, 4, 5],
		);
	});

	it("listQnaEntries defaults to 20", async () => {
		const { entries, total } = await listQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 5, "Should return all when less than limit");
		assert.strictEqual(total, 5);
		assert.deepStrictEqual(
			entries.map((e) => e.id),
			[1, 2, 3, 4, 5],
		);
	});

	it("queryQnaEntries searches question field", async () => {
		const entries = await queryQnaEntries(tmpDir, "semicolons");
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.question, "Explain semicolons in CSV");
		assert.strictEqual(entries[0]!.id, 4);
	});

	it("queryQnaEntries searches answer field", async () => {
		const entries = await queryQnaEntries(tmpDir, "Grail");
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.answer, "To seek the Holy Grail");
		assert.strictEqual(entries[0]!.id, 2);
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
// Integration tests: absolute ids on list/search (issue #1614)
// ============================================================================

describe("list/search absolute ids (issue #1614)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-abs-id-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Append N entries, each "Entry i" / "Answer i". */
	async function appendN(n: number): Promise<void> {
		for (let i = 1; i <= n; i++) {
			const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
			await appendQnaEntry(tmpDir, ts, `Entry ${i}`, `Answer ${i}`);
		}
	}

	/** Strip the absolute id to compare against plain QnaEntry. */
	function stripId(e: {
		datetime: string;
		question: string;
		answer: string;
		id: number;
	}): QnaEntry {
		return { datetime: e.datetime, question: e.question, answer: e.answer };
	}

	it("total < limit → all entries with ids 1..N and total N", async () => {
		await appendN(3);
		const { entries, total } = await listQnaEntries(tmpDir, 20);
		assert.strictEqual(total, 3);
		assert.strictEqual(entries.length, 3);
		assert.deepStrictEqual(
			entries.map((e) => e.id),
			[1, 2, 3],
		);
	});

	it("total == limit → ids 1..N", async () => {
		await appendN(5);
		const { entries, total } = await listQnaEntries(tmpDir, 5);
		assert.strictEqual(total, 5);
		assert.deepStrictEqual(
			entries.map((e) => e.id),
			[1, 2, 3, 4, 5],
		);
	});

	it("30 entries, limit 20 → first row id 11, last row id 30, total 30", async () => {
		await appendN(30);
		const { entries, total } = await listQnaEntries(tmpDir, 20);
		assert.strictEqual(total, 30);
		assert.strictEqual(entries.length, 20);
		// start = total - limit, id = start + i + 1 → 11..30. A naive baseIndex
		// of 10 (total - limit, without +1) must fail this assertion.
		assert.strictEqual(entries[0]!.id, 11);
		assert.strictEqual(entries[entries.length - 1]!.id, 30);
	});

	it("roundtrip: every row in a truncated list is fetchable via getQnaEntry(id)", async () => {
		await appendN(30);
		const { entries } = await listQnaEntries(tmpDir, 20);
		for (const row of entries) {
			const fetched = await getQnaEntry(tmpDir, row.id);
			assert.ok(fetched !== null && fetched !== undefined, `id ${row.id} should resolve`);
			assert.deepStrictEqual(fetched, stripId(row));
		}
	});

	it("limit=1 → single entry with id = total", async () => {
		await appendN(30);
		const { entries, total } = await listQnaEntries(tmpDir, 1);
		assert.strictEqual(total, 30);
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.id, 30);
	});

	it("fractional limit → truncated integer, ids integral and get-able", async () => {
		await appendN(30);
		// 1.5 must behave exactly like 1 (slice truncates its index toward
		// zero, so ids must come from the same integer). The bug produced
		// fractional ids (29.5/30.5) that no get could resolve.
		const { entries, total } = await listQnaEntries(tmpDir, 1.5);
		assert.strictEqual(total, 30);
		assert.strictEqual(entries.length, 1, "trunc(1.5) = 1 entry, not 2");
		assert.ok(Number.isInteger(entries[0]!.id), "id must be an integer");
		assert.strictEqual(entries[0]!.id, 30);
		const fetched = await getQnaEntry(tmpDir, entries[0]!.id);
		assert.ok(fetched !== null && fetched !== undefined);
		assert.deepStrictEqual(fetched, stripId(entries[0]!));
	});

	it("limit=0 → empty entries, total N", async () => {
		await appendN(30);
		const { entries, total } = await listQnaEntries(tmpDir, 0);
		assert.deepStrictEqual(entries, []);
		assert.strictEqual(total, 30);
	});

	it("empty log → entries [], total 0", async () => {
		const { entries, total } = await listQnaEntries(tmpDir, 20);
		assert.deepStrictEqual(entries, []);
		assert.strictEqual(total, 0);
	});

	it("query: matches at positions 5 and 27 carry ids [5, 27] and roundtrip", async () => {
		for (let i = 1; i <= 30; i++) {
			const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
			const marker = i === 5 || i === 27 ? "quintessential " : "";
			await appendQnaEntry(tmpDir, ts, `${marker}Entry ${i}`, `Answer ${i}`);
		}

		const results = await queryQnaEntries(tmpDir, "quintessential");
		assert.strictEqual(results.length, 2);
		assert.deepStrictEqual(
			results.map((e) => e.id),
			[5, 27],
		);
		for (const row of results) {
			const fetched = await getQnaEntry(tmpDir, row.id);
			assert.ok(fetched !== null && fetched !== undefined);
			assert.deepStrictEqual(fetched, stripId(row));
		}
	});

	it("rotation: 105 entries → list ids 86..105, get(86) = first listed row, total 105", async () => {
		await appendN(105); // forces rotateQnaFile at 100
		const { entries, total } = await listQnaEntries(tmpDir, 20);
		assert.strictEqual(total, 105);
		assert.strictEqual(entries.length, 20);
		assert.strictEqual(entries[0]!.id, 86);
		assert.strictEqual(entries[entries.length - 1]!.id, 105);
		const fetched = await getQnaEntry(tmpDir, 86);
		assert.ok(fetched !== null && fetched !== undefined);
		assert.deepStrictEqual(fetched, stripId(entries[0]!));
	});

	it("corrupted line mid-file → ids count parsed entries only and roundtrip", async () => {
		// Write valid + corrupted + valid directly (ids count parsed entries only)
		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		await fs.promises.mkdir(path.dirname(jsonlPath), { recursive: true });
		const valid1 = '{"datetime":"2026-05-15T19:00:00.000Z","question":"Q1","answer":"A1"}\n';
		const corrupted = "not-json\n";
		const valid2 = '{"datetime":"2026-05-15T20:00:00.000Z","question":"Q2","answer":"A2"}\n';
		await fs.promises.writeFile(jsonlPath, valid1 + corrupted + valid2, "utf-8");

		const origWarn = console.warn;
		console.warn = () => {};
		try {
			const { entries, total } = await listQnaEntries(tmpDir, 20);
			assert.strictEqual(total, 2);
			assert.deepStrictEqual(
				entries.map((e) => e.id),
				[1, 2],
			);
			for (const row of entries) {
				const fetched = await getQnaEntry(tmpDir, row.id);
				assert.ok(fetched !== null && fetched !== undefined);
				assert.deepStrictEqual(fetched, stripId(row));
			}
		} finally {
			console.warn = origWarn;
		}
	});
});

// ============================================================================
// Integration tests: migrateQnaFromCsv (Phase 2 — atomic migration)
// ============================================================================
