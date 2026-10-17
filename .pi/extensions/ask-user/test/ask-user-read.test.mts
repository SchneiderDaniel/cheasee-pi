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

import { appendQnaEntry } from "../jsonl-logger.ts";

import askUser, { successResult } from "../index.ts";

// ============================================================================
// Unit tests: validateQnaEntry
// ============================================================================

// Split from ask-user.test.mts (issue #2035 Long File refactor).
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

		const parsed = result.structuredContent as any;
		assert.strictEqual(parsed.count, 2);
		assert.strictEqual(parsed.entries.length, 2);
		assert.ok(!parsed.message, "Should not have message when entries exist");
		assert.ok(
			!result.content[0]!.text.includes("{"),
			"content is a readable summary, not the JSON payload",
		);

		assert.strictEqual(result.details.count, 2);
		assert.strictEqual((result.details.entries as Array<unknown>).length, 2);
	});

	it("includes total field when provided (list action)", () => {
		const entries = [
			{ id: 11, datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" },
			{ id: 12, datetime: "2026-05-15T20:00:00.000Z", question: "Q2", answer: "A2" },
		];
		const result = successResult(entries, entries.length, 35);

		const parsed = result.structuredContent as any;
		assert.strictEqual(parsed.count, 2);
		assert.strictEqual(parsed.total, 35, "Payload should carry total history size");
		assert.strictEqual(parsed.entries[0]!.id, 11, "Entries keep their absolute ids");
		assert.strictEqual(result.details.total, 35, "Details should carry total too");
	});

	it("omits total field when not provided (get/query action)", () => {
		const entry = { datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" };
		const result = successResult([entry], 1);
		const parsed = result.structuredContent as any;
		assert.ok(!("total" in parsed), "No total for get/query payloads");
		assert.ok(!("total" in result.details), "No total in details for get/query");
	});

	it("returns message field when entries array is empty", () => {
		const result = successResult([], 0);
		const parsed = result.structuredContent as any;
		assert.strictEqual(parsed.count, 0);
		assert.deepStrictEqual(parsed.entries, []);
		assert.strictEqual(parsed.message, "No Q&A history yet");

		assert.strictEqual(result.details.count, 0);
		assert.deepStrictEqual(result.details.entries as Array<unknown>, []);
	});

	it("allows alternative count for single-entry display", () => {
		const entry = { datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" };
		const result = successResult([entry], 1);
		const parsed = result.structuredContent as any;
		assert.strictEqual(parsed.count, 1);
		assert.strictEqual(parsed.entries.length, 1);
		assert.strictEqual(parsed.entries[0]!.question, "Q1");
		assert.ok(!parsed.message, "Should not have message when entry exists");
	});

	it("structuredContent mirrors the details payload (minus format)", () => {
		const entries = [{ datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" }];
		const result = successResult(entries, 1);
		const { format, ...detailsPayload } = result.details;
		assert.strictEqual(format, "qna-result-v1");
		assert.deepStrictEqual(result.structuredContent, detailsPayload);
	});

	it("content is a single readable text block", () => {
		const result = successResult([], 0);
		assert.strictEqual(result.content.length, 1);
		assert.strictEqual(result.content[0]!.type, "text");
		assert.strictEqual(result.content[0]!.text, "No Q&A history yet");
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
		const parsed = result.structuredContent as any;
		assert.strictEqual(parsed.count, 2);
		assert.strictEqual(parsed.entries.length, 2);
		assert.strictEqual(result.details.count, 2);
		assert.strictEqual((result.details.entries as Array<unknown>).length, 2);
	});
});
