/**
 * Tests for session-logger/renderer.ts — supervisor custom message details
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-renderer.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { renderSessionToMarkdown, parseSessionStats } from "../renderer.ts";

// ---------------------------------------------------------------------------
// renderSessionToMarkdown — supervisor custom entry rendering
// ---------------------------------------------------------------------------

// Split from session-logger-renderer.test.mts (issue #2035 Long File refactor).
describe("parseSessionStats — fileModifications action filter (Set membership)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-filemods-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const header = {
			type: "session",
			id: "test-session-filemods",
			timestamp: "2025-06-01T10:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	function parseFileMods(entries: Record<string, unknown>[]) {
		const parsed = parseSessionStats(writeJsonl(entries));
		assert.ok(parsed, "should parse");
		return parsed.fileModifications;
	}

	function assistantWithToolCalls(toolCalls: Record<string, unknown>[]) {
		return {
			type: "message",
			timestamp: "2025-06-01T10:01:00Z",
			message: {
				role: "assistant",
				content: toolCalls,
			},
		};
	}

	it("read/write/edit toolCalls produce one entry each with identity action, in push order", () => {
		const fileMods = parseFileMods([
			assistantWithToolCalls([
				{ type: "toolCall", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", name: "write", arguments: { path: "b.txt", content: "abc" } },
				{ type: "toolCall", name: "edit", arguments: { path: "c.txt" } },
			]),
		]);

		assert.strictEqual(fileMods.length, 3, "exactly 3 entries");
		assert.deepStrictEqual(
			fileMods.map((m) => m.action),
			["read", "write", "edit"],
			"action equals name for each, order read→write→edit",
		);
	});

	it("non-file-mod tool names (bash, web_search, ripgrep_search) produce no entries", () => {
		const fileMods = parseFileMods([
			assistantWithToolCalls([
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", name: "web_search", arguments: { query: "x" } },
				{ type: "toolCall", name: "ripgrep_search", arguments: { query: "x" } },
			]),
		]);

		assert.deepStrictEqual(fileMods, [], "null path → no fileMods entry");
	});

	it("case/whitespace variants of read/edit never match (=== semantics preserved)", () => {
		const fileMods = parseFileMods([
			assistantWithToolCalls([
				{ type: "toolCall", name: "READ", arguments: { path: "a" } },
				{ type: "toolCall", name: "Edit", arguments: { path: "b" } },
				{ type: "toolCall", name: "read ", arguments: { path: "c" } },
				{ type: "toolCall", name: "read\n", arguments: { path: "d" } },
			]),
		]);

		assert.deepStrictEqual(fileMods, [], "no case/whitespace variant matches");
	});

	it("empty string and missing name produce no entries", () => {
		const fileMods = parseFileMods([
			assistantWithToolCalls([
				{ type: "toolCall", name: "", arguments: { path: "a" } },
				{ type: "toolCall", arguments: { path: "b" } },
			]),
		]);

		assert.deepStrictEqual(fileMods, [], "empty/missing name → no entry");
	});

	it("write size branch preserved: content.length when present, undefined when absent", () => {
		const fileMods = parseFileMods([
			assistantWithToolCalls([
				{ type: "toolCall", name: "write", arguments: { path: "a.txt", content: "abc" } },
				{ type: "toolCall", name: "write", arguments: { path: "b.txt" } },
			]),
		]);

		assert.strictEqual(fileMods.length, 2);
		assert.strictEqual(fileMods[0].action, "write");
		assert.strictEqual(fileMods[0].size, 3, "size = content.length");
		assert.strictEqual(fileMods[1].action, "write");
		assert.strictEqual(fileMods[1].size, undefined, "no content → size undefined");
	});

	it("read/edit entries never carry size even when arguments.content present", () => {
		const fileMods = parseFileMods([
			assistantWithToolCalls([
				{ type: "toolCall", name: "read", arguments: { path: "a.txt", content: "x" } },
				{ type: "toolCall", name: "edit", arguments: { path: "b.txt", content: "y" } },
			]),
		]);

		assert.strictEqual(fileMods.length, 2);
		assert.strictEqual(fileMods[0].size, undefined, "read carries no size");
		assert.strictEqual(fileMods[1].size, undefined, "edit carries no size (write-only)");
	});

	it("toolCall without arguments.path falls back to ?", () => {
		const fileMods = parseFileMods([assistantWithToolCalls([{ type: "toolCall", name: "read" }])]);

		assert.strictEqual(fileMods.length, 1);
		assert.strictEqual(fileMods[0].path, "?", 'path ?? "?" fallback preserved');
	});

	it("interleaved non-toolCall content items are skipped, toolCalls still captured", () => {
		const fileMods = parseFileMods([
			assistantWithToolCalls([
				{ type: "text", text: "thinking" },
				{ type: "toolCall", name: "read", arguments: { path: "a.txt" } },
				{ type: "text", text: "more" },
			]),
		]);

		assert.strictEqual(fileMods.length, 1, "only toolCall entry captured");
		assert.strictEqual(fileMods[0].action, "read");
	});
});

describe("renderSessionToMarkdown — subagent tool calls in Tool Usage table", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-renderer-sub-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const header = {
			type: "session",
			id: "test-session-sub",
			timestamp: "2025-06-01T10:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	it("Tool Usage table includes tools from supervisor tool-complete entries", () => {
		const filepath = writeJsonl([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "content" }],
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					agentName: "developer",
					isError: false,
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("## Tool Usage"), "Tool Usage section present");
		assert.ok(md.includes("read"), "includes native tool read");
		assert.ok(md.includes("bash"), "includes subagent tool bash");
		// Both should appear in table rows
		assert.ok(md.includes("| \`read\` | 1 |"), "read row with 1 call");
		assert.ok(md.includes("| \`bash\` | 1 |"), "bash row with 1 call");
	});

	it("tool counts from subagent entries aggregated into same table rows when tool names match", () => {
		const filepath = writeJsonl([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "ok" }],
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "bash",
					agentName: "developer",
					isError: true,
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("| \`bash\` | 2 | 1 |"), "bash aggregated: 2 calls, 1 error");
	});

	it("session with ONLY supervisor tool-complete entries and zero native toolResult entries renders correctly", () => {
		const filepath = writeJsonl([
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "web_search",
					agentName: "researcher",
					isError: false,
				},
			},
			{
				type: "custom",
				customType: "supervisor",
				details: {
					eventType: "tool-complete",
					toolName: "read",
					agentName: "researcher",
					isError: false,
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("## Tool Usage"), "Tool Usage section present");
		assert.ok(md.includes("web_search"), "includes web_search");
		assert.ok(md.includes("read"), "includes read");
		assert.ok(md.includes("| \`read\` | 1 |"), "read row with 1 call");
		assert.ok(md.includes("| \`web_search\` | 1 |"), "web_search row with 1 call");
	});
});

// ---------------------------------------------------------------------------
// parseSessionStats — nestedCalls rollup (JSONL is the authority for nested)
// ---------------------------------------------------------------------------
