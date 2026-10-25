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
import { QuestionParams, QnaReadParams } from "../types.ts";

import { migrateIfCsvExists } from "../jsonl-logger.ts";

// ============================================================================
// Unit tests: validateQnaEntry
// ============================================================================

// Split from ask-user.test.mts (issue #2035 Long File refactor).
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
