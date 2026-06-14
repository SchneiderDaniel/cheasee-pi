/**
 * Tests for jsonl-parser.ts — parse JSONL session files into SessionData
 *
 * Uses real temp files via fs.writeFileSync() in before/after hooks.
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/jsonl-parser.test.ts
 */

import assert from "node:assert";
import { describe, it, before, after } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonlFile } from "../jsonl-parser.ts";

const TMP_DIR = "/tmp/session-advice-jsonl-test";
const SAMPLE_VALID = path.join(TMP_DIR, "valid.jsonl");
const SAMPLE_EMPTY = path.join(TMP_DIR, "empty.jsonl");
const SAMPLE_WHITESPACE = path.join(TMP_DIR, "whitespace.jsonl");
const SAMPLE_SINGLE_LINE = path.join(TMP_DIR, "single-line.jsonl");
const SAMPLE_CORRUPT = path.join(TMP_DIR, "corrupt.jsonl");
const SAMPLE_NO_ID = path.join(TMP_DIR, "no-id.jsonl");
const SAMPLE_MULTI_TOOL_CALLS = path.join(TMP_DIR, "multi-tool-calls.jsonl");
const SAMPLE_TOOL_ERROR = path.join(TMP_DIR, "tool-error.jsonl");
const SAMPLE_NO_USAGE = path.join(TMP_DIR, "no-usage.jsonl");
const SAMPLE_USAGE_COST = path.join(TMP_DIR, "usage-cost.jsonl");
const SAMPLE_LARGE = path.join(TMP_DIR, "large.jsonl");

before(() => {
	fs.mkdirSync(TMP_DIR, { recursive: true });

	// Valid 3-line JSONL: session + assistant + toolResult with usage
	fs.writeFileSync(
		SAMPLE_VALID,
		JSON.stringify({ type: "session", id: "sess-1", timestamp: "2024-01-01T00:00:00Z" }) +
			"\n" +
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "read",
							arguments: { path: "/repo/file.ts" },
						},
					],
					usage: { input: 50, output: 100, totalTokens: 150, cost: { total: 0.003 } },
				},
			}) +
			"\n" +
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					content: [{ type: "text", text: "file content here" }],
				},
			}) +
			"\n",
		"utf-8",
	);

	fs.writeFileSync(SAMPLE_EMPTY, "", "utf-8");
	fs.writeFileSync(SAMPLE_WHITESPACE, "   \n  \n  ", "utf-8");

	// Single line (session header only, no entries)
	fs.writeFileSync(
		SAMPLE_SINGLE_LINE,
		JSON.stringify({ type: "session", id: "sess-single", timestamp: "" }) + "\n",
		"utf-8",
	);

	// Corrupt JSON
	fs.writeFileSync(SAMPLE_CORRUPT, "{ invalid json\n", "utf-8");

	// No ID in header
	fs.writeFileSync(
		SAMPLE_NO_ID,
		JSON.stringify({ type: "session", timestamp: "2024-01-01" }) + "\n",
		"utf-8",
	);

	// Assistant message with 2 tool calls
	fs.writeFileSync(
		SAMPLE_MULTI_TOOL_CALLS,
		JSON.stringify({ type: "session", id: "sess-multi", timestamp: "" }) +
			"\n" +
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "read", arguments: { path: "/repo/a.ts" } },
						{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
					],
					usage: { input: 10, output: 20, totalTokens: 30 },
				},
			}) +
			"\n",
		"utf-8",
	);

	// Tool result with isError: true
	fs.writeFileSync(
		SAMPLE_TOOL_ERROR,
		JSON.stringify({ type: "session", id: "sess-err", timestamp: "" }) +
			"\n" +
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "/repo/missing.ts" } }],
				},
			}) +
			"\n" +
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: true,
					content: [{ type: "text", text: "ENOENT" }],
				},
			}) +
			"\n",
		"utf-8",
	);

	// Entry without usage
	fs.writeFileSync(
		SAMPLE_NO_USAGE,
		JSON.stringify({ type: "session", id: "sess-nousage", timestamp: "" }) +
			"\n" +
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "/repo/file.ts" } }],
				},
			}) +
			"\n",
		"utf-8",
	);

	// Entry with usage.cost field
	fs.writeFileSync(
		SAMPLE_USAGE_COST,
		JSON.stringify({ type: "session", id: "sess-cost", timestamp: "" }) +
			"\n" +
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "/repo/file.ts" } }],
					usage: { input: 50, output: 100, totalTokens: 150, cost: { total: 0.003 } },
				},
			}) +
			"\n",
		"utf-8",
	);

	// 1000-line JSONL for boundary test
	const largeLines: string[] = [
		JSON.stringify({ type: "session", id: "sess-large", timestamp: "2024-01-01" }),
	];
	for (let i = 0; i < 999; i++) {
		largeLines.push(
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: `/repo/file-${i}.ts` } }],
				},
			}),
		);
	}
	fs.writeFileSync(SAMPLE_LARGE, largeLines.join("\n") + "\n", "utf-8");
});

after(() => {
	try {
		fs.rmSync(TMP_DIR, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});

describe("parseJsonlFile", () => {
	it("parses valid 3-line JSONL (session + assistant + toolResult) into SessionData", () => {
		const result = parseJsonlFile(SAMPLE_VALID);
		assert.ok(result !== null, "should return SessionData");
		assert.strictEqual(result!.sessionId, "sess-1");
		assert.strictEqual(result!.timestamp, "2024-01-01T00:00:00Z");
		// 1 tool_use (from assistant) + 1 tool_result = 2 entries
		assert.strictEqual(
			result!.entries.length,
			2,
			"should have 2 entries (tool_call + tool_result)",
		);
	});

	it("entry has assistantCost and usage when present in JSONL", () => {
		const result = parseJsonlFile(SAMPLE_VALID);
		assert.ok(result !== null);
		const entry = result!.entries[0];
		assert.ok(entry.assistantCost !== undefined, "should have assistantCost");
		assert.strictEqual(entry.assistantCost, 150);
		assert.ok(entry.usage !== undefined, "should have usage");
		assert.strictEqual(entry.usage!.totalTokens, 150);
	});

	it("returns null for empty string", () => {
		assert.strictEqual(parseJsonlFile(SAMPLE_EMPTY), null);
	});

	it("returns null for whitespace-only content", () => {
		assert.strictEqual(parseJsonlFile(SAMPLE_WHITESPACE), null);
	});

	it("returns result with entries for single valid line (session header only → 0 entries)", () => {
		const result = parseJsonlFile(SAMPLE_SINGLE_LINE);
		assert.ok(result !== null);
		assert.strictEqual(result!.sessionId, "sess-single");
		assert.strictEqual(result!.entries.length, 0);
	});

	it("throws SyntaxError for corrupt JSON", () => {
		assert.throws(() => parseJsonlFile(SAMPLE_CORRUPT), SyntaxError);
	});

	it("uses 'unknown' for missing session id", () => {
		const result = parseJsonlFile(SAMPLE_NO_ID);
		assert.ok(result !== null);
		assert.strictEqual(result!.sessionId, "unknown");
	});

	it("handles assistant message with 2 tool calls → 2 entries", () => {
		const result = parseJsonlFile(SAMPLE_MULTI_TOOL_CALLS);
		assert.ok(result !== null);
		assert.strictEqual(result!.entries.length, 2);
	});

	it("tool result with isError: true → entry has isError true", () => {
		const result = parseJsonlFile(SAMPLE_TOOL_ERROR);
		assert.ok(result !== null);
		const toolResult = result!.entries.find((e) => e.type === "tool_result");
		assert.ok(toolResult !== undefined);
		assert.strictEqual(toolResult!.isError, true);
	});

	it("entries without usage → assistantCost undefined, usage undefined", () => {
		const result = parseJsonlFile(SAMPLE_NO_USAGE);
		assert.ok(result !== null);
		const entry = result!.entries[0];
		assert.strictEqual(entry.assistantCost, undefined);
		assert.strictEqual(entry.usage, undefined);
	});

	it("entry with usage.cost → cost field populated", () => {
		const result = parseJsonlFile(SAMPLE_USAGE_COST);
		assert.ok(result !== null);
		const entry = result!.entries[0];
		assert.ok(entry.usage !== undefined);
		assert.strictEqual(entry.usage!.cost, 0.003);
	});

	it("1000-line JSONL → parses without crash", () => {
		const result = parseJsonlFile(SAMPLE_LARGE);
		assert.ok(result !== null);
		assert.strictEqual(result!.sessionId, "sess-large");
		assert.ok(result!.entries.length > 0);
	});
});
