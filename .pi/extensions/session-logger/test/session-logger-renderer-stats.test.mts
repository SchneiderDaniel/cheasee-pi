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
describe("parseSessionStats — perTurnTokens characterization", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-perturn-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
	it("parseSessionStats is a function", () => {
		assert.strictEqual(
			typeof parseSessionStats,
			"function",
			"parseSessionStats should be a function",
		);
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const header = {
			type: "session",
			id: "test-session-perturn",
			timestamp: "2025-06-01T10:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	it("returns perTurnTokens with 2 entries for 2 user turns with assistant usage", () => {
		const filepath = writeJsonl([
			{
				type: "message",
				timestamp: "2025-06-01T10:01:00Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			},
			{
				type: "message",
				timestamp: "2025-06-01T10:02:00Z",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 10,
						cacheWrite: 5,
						totalTokens: 165,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
					},
					content: [{ type: "text", text: "Hi there!" }],
				},
			},
			{
				type: "message",
				timestamp: "2025-06-01T10:03:00Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "Write code" }],
				},
			},
			{
				type: "message",
				timestamp: "2025-06-01T10:04:00Z",
				message: {
					role: "assistant",
					usage: {
						input: 200,
						output: 100,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 300,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.004 },
					},
					content: [{ type: "text", text: "Sure!" }],
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(parsed.perTurnTokens.length, 2, "should have 2 per-turn entries");

		// Turn 0: first user turn + assistant usage
		assert.strictEqual(parsed.perTurnTokens[0].turnIndex, 0);
		assert.strictEqual(parsed.perTurnTokens[0].tokens, 165);
		assert.strictEqual(parsed.perTurnTokens[0].cost, 0.002);

		// Turn 1: second user turn + assistant usage
		assert.strictEqual(parsed.perTurnTokens[1].turnIndex, 1);
		assert.strictEqual(parsed.perTurnTokens[1].tokens, 300);
		assert.strictEqual(parsed.perTurnTokens[1].cost, 0.004);
	});

	it("empty file (session header only, no messages) returns parsed stats with empty perTurnTokens", () => {
		const filepath = path.join(tmpDir, "empty-session.jsonl");
		const header = {
			type: "session",
			id: "test-empty",
			timestamp: "2025-06-01T10:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		fs.writeFileSync(filepath, JSON.stringify(header) + "\n", "utf-8");

		const parsed = parseSessionStats(filepath);
		// Header-only is valid (1 entry), returns stats with zeroed fields
		assert.ok(parsed, "should parse");
		assert.ok(Array.isArray(parsed.perTurnTokens));
		assert.strictEqual(parsed.perTurnTokens.length, 0);
		assert.strictEqual(parsed.entryCount, 1);
	});

	it("0 user turns but an assistant message — perTurnTokens has 1 entry at turnIndex 0", () => {
		const filepath = writeJsonl([
			{
				type: "message",
				timestamp: "2025-06-01T10:01:00Z",
				message: {
					role: "assistant",
					usage: {
						input: 50,
						output: 25,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 75,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
					content: [{ type: "text", text: "Hello" }],
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(parsed.perTurnTokens.length, 1, "should have 1 per-turn entry");
		assert.strictEqual(parsed.perTurnTokens[0].turnIndex, 0);
		assert.strictEqual(parsed.perTurnTokens[0].tokens, 75);
		assert.strictEqual(parsed.perTurnTokens[0].cost, 0.001);
	});

	it("tool results and errors — perTurnTokens entries include toolCount and errorCount", () => {
		const filepath = writeJsonl([
			{
				type: "message",
				timestamp: "2025-06-01T10:01:00Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "Run tests" }],
				},
			},
			{
				type: "message",
				timestamp: "2025-06-01T10:02:00Z",
				message: {
					role: "assistant",
					usage: {
						input: 50,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 50,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0 },
					},
					content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
				},
			},
			{
				type: "message",
				timestamp: "2025-06-01T10:03:00Z",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "All tests passed" }],
				},
			},
			{
				type: "message",
				timestamp: "2025-06-01T10:04:00Z",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "Failed" }],
				},
			},
		]);

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.strictEqual(parsed.perTurnTokens.length, 1, "should have 1 per-turn entry");
		assert.strictEqual(parsed.perTurnTokens[0].toolCount, 2, "should count 2 tool results");
		assert.strictEqual(parsed.perTurnTokens[0].errorCount, 1, "should count 1 error");
	});

	it("no messages — perTurnTokens is empty array", () => {
		const filepath = path.join(tmpDir, "no-messages.jsonl");
		const header = {
			type: "session",
			id: "test-no-msgs",
			timestamp: "2025-06-01T10:00:00Z",
			cwd: "/tmp",
			version: 1,
		};
		const someEntry = {
			type: "model_change",
			timestamp: "2025-06-01T10:01:00Z",
			provider: "openai",
			modelId: "gpt-4",
		};
		const lines = [JSON.stringify(header), JSON.stringify(someEntry)].join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");

		const parsed = parseSessionStats(filepath);
		assert.ok(parsed, "should parse");
		assert.ok(Array.isArray(parsed.perTurnTokens));
		assert.strictEqual(parsed.perTurnTokens.length, 0);
	});

	it("truly empty file returns null", () => {
		const filepath = path.join(tmpDir, "truly-empty.jsonl");
		fs.writeFileSync(filepath, "", "utf-8");
		const parsed = parseSessionStats(filepath);
		assert.strictEqual(parsed, null);
	});
});

// ---------------------------------------------------------------------------
// renderSessionToMarkdown — header overrides (name/mode)
// ---------------------------------------------------------------------------

describe("renderSessionToMarkdown — header name/mode overrides", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-header-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const header = {
			type: "session",
			id: "test-header-session",
			timestamp: "2025-06-01T10:00:00Z",
			cwd: "/tmp",

			version: 1,
		};
		const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	it("renderSessionToMarkdown is a function that accepts overrides", () => {
		assert.strictEqual(
			typeof renderSessionToMarkdown,
			"function",
			"renderSessionToMarkdown should be a function",
		);
	});

	it("with mode override renders Mode row between Start and CWD", () => {
		const filepath = writeJsonl([]);
		const md = renderSessionToMarkdown(filepath, { mode: "tui" });

		const startIdx = md.indexOf("| **Start**");
		const modeIdx = md.indexOf("| **Mode** |");
		const cwdIdx = md.indexOf("| **CWD**");

		assert.ok(modeIdx >= 0, "Should render Mode row");
		assert.ok(modeIdx > startIdx, "Mode row should be after Start");
		assert.ok(cwdIdx > modeIdx, "CWD row should be after Mode");
		assert.ok(md.includes("| **Mode** | tui |"), "Should contain Mode value");
	});

	it("with sessionName override renders Name row between Start and CWD", () => {
		const filepath = writeJsonl([]);
		const md = renderSessionToMarkdown(filepath, { sessionName: "fix-bug-123" });

		const startIdx = md.indexOf("| **Start**");
		const nameIdx = md.indexOf("| **Name** |");
		const cwdIdx = md.indexOf("| **CWD**");

		assert.ok(nameIdx >= 0, "Should render Name row");
		assert.ok(nameIdx > startIdx, "Name row should be after Start");
		assert.ok(cwdIdx > nameIdx, "CWD row should be after Name");
		assert.ok(md.includes("| **Name** | \`fix-bug-123\` |"), "Should contain Name value");
	});

	it("with both overrides renders both Name and Mode rows in correct order", () => {
		const filepath = writeJsonl([]);
		const md = renderSessionToMarkdown(filepath, {
			sessionName: "fix-bug-123",
			mode: "tui",
		});

		const startIdx = md.indexOf("| **Start**");
		const nameIdx = md.indexOf("| **Name** |");
		const modeIdx = md.indexOf("| **Mode** |");
		const cwdIdx = md.indexOf("| **CWD**");

		assert.ok(nameIdx >= 0, "Should render Name row");
		assert.ok(modeIdx >= 0, "Should render Mode row");
		assert.ok(nameIdx > startIdx, "Name row after Start");
		assert.ok(modeIdx > startIdx, "Mode row after Start");
		assert.ok(cwdIdx > modeIdx, "CWD after Mode");
		assert.ok(cwdIdx > nameIdx, "CWD after Name");
	});

	it("without overrides does not render Name or Mode rows (backward compat)", () => {
		const filepath = writeJsonl([]);
		const md = renderSessionToMarkdown(filepath);

		assert.ok(!md.includes("| **Name** |"), "Should not render Name row");
		assert.ok(!md.includes("| **Mode** |"), "Should not render Mode row");
	});

	it("Mode row uses escMd escaping for pipe/backtick in mode string", () => {
		const filepath = writeJsonl([]);
		const md = renderSessionToMarkdown(filepath, { mode: "rpc|json" });

		assert.ok(md.includes("| **Mode** | rpc\\|json |"), "Mode value should escape pipe");
	});

	it("Name row uses escMd escaping for pipe/backtick in name string", () => {
		const filepath = writeJsonl([]);
		const md = renderSessionToMarkdown(filepath, { sessionName: "test\`name|v2" });

		assert.ok(md.includes("\\`"), "Name value should escape backtick");
		assert.ok(md.includes("\\|"), "Name value should escape pipe");
	});

	it("empty mode string renders as empty value", () => {
		const filepath = writeJsonl([]);
		const md = renderSessionToMarkdown(filepath, { mode: "" });

		assert.ok(md.includes("| **Mode** |  |"), "Empty mode should render as empty value");
	});

	it("overrides do not affect other header rows or sections", () => {
		const filepath = writeJsonl([]);
		const md = renderSessionToMarkdown(filepath, { mode: "tui" });

		// Standard rows still present
		assert.ok(md.includes("| **Session** |"), "Session row present");
		assert.ok(md.includes("| **Start** |"), "Start row present");
		assert.ok(md.includes("| **CWD** |"), "CWD row present");
		assert.ok(md.includes("| **Version** |"), "Version row present");
		assert.ok(md.includes("| **Entries** |"), "Entries row present");

		// Token table not affected
		assert.ok(md.includes("| **Input tokens** |"), "Input tokens row present");
	});
});

// ---------------------------------------------------------------------------
// parseSessionStats — subagent tool calls from supervisor custom entries
// ---------------------------------------------------------------------------
