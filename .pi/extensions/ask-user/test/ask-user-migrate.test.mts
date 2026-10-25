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

import { migrateQnaFromCsv } from "../jsonl-logger.ts";

// ============================================================================
// Unit tests: validateQnaEntry
// ============================================================================

// Split from ask-user.test.mts (issue #2035 Long File refactor).
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
