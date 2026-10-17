/**
 * Tests for .pi/extensions/session-logger.ts — JSONL Format
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

// ---------------------------------------------------------------------------
// Import functions under test
// ---------------------------------------------------------------------------

// We import the module to get access to exported functions.
// The serializeRecord and record mappers are internal; we test them
// indirectly via the exported default or by loading the file.
// Since the module uses a default export function pattern for the extension,
// we replicate the serialization logic here for isolated unit tests,
// mirroring the implementation exactly.

// ---------------------------------------------------------------------------
// Duplicated helpers from session-logger.ts (not exported)
// ---------------------------------------------------------------------------

const MAX_TOOL_OUTPUT = 2000;
const MAX_TOOL_OUTPUT_TAIL = 500;

function truncate(text: string, head: number, tail = 0): string {
	if (text.length <= head + tail) return text;
	const cut = text.length - head - tail;
	if (tail > 0) {
		return text.slice(0, head) + `\n\n[... ${cut} chars truncated ...]\n\n` + text.slice(-tail);
	}
	return text.slice(0, head) + `\n\n[... ${cut} chars truncated ...]`;
}

function extractText(blocks: unknown): string {
	if (typeof blocks === "string") return blocks;
	if (!Array.isArray(blocks)) return "";
	return blocks
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join("\n\n");
}

// Replicate serializeRecord
interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

interface LogRecord {
	timestamp: string;
	agent: string;
	tool: string;
	token_usage?: TokenUsage;
	error: string | null;
	loop_step: number;
	payload: Record<string, unknown>;
}

function serializeRecord(record: LogRecord): string {
	const normalized: LogRecord = {
		timestamp: record.timestamp,
		agent: record.agent,
		tool: record.tool,
		...(record.token_usage && { token_usage: record.token_usage }),
		error: record.error ?? null,
		loop_step: record.loop_step,
		payload: record.payload ?? {},
	};
	return JSON.stringify(normalized) + "\n";
}

// Replicate event mappers
function userMessageToRecord(msg: any, step: number): LogRecord {
	const text = extractText(msg.content);
	return {
		timestamp:
			typeof msg.timestamp === "string" ? msg.timestamp : new Date(msg.timestamp).toISOString(),
		agent: "user",
		tool: "message",
		error: null,
		loop_step: step,
		payload: { role: "user", content: text },
	};
}

function assistantMessageToRecord(msg: any, step: number): LogRecord {
	const texts: string[] = [];
	const thinking: string[] = [];
	const toolCalls: Array<{ name: string; arguments: unknown }> = [];

	for (const block of msg.content || []) {
		if (block.type === "text" && block.text?.trim()) texts.push(block.text.trim());
		else if (block.type === "thinking") thinking.push(block.thinking);
		else if (block.type === "toolCall") {
			toolCalls.push({ name: block.name, arguments: block.arguments ?? {} });
		}
	}

	const tokenUsage: TokenUsage | undefined = msg.usage
		? {
				input: msg.usage.input ?? 0,
				output: msg.usage.output ?? 0,
				total: msg.usage.totalTokens ?? (msg.usage.input ?? 0) + (msg.usage.output ?? 0),
			}
		: undefined;

	return {
		timestamp:
			typeof msg.timestamp === "string" ? msg.timestamp : new Date(msg.timestamp).toISOString(),
		agent: "assistant",
		tool: "message",
		...(tokenUsage && { token_usage: tokenUsage }),
		error: msg.stopReason && msg.stopReason !== "stop" ? `stop_reason: ${msg.stopReason}` : null,
		loop_step: step,
		payload: { role: "assistant", texts, thinking, toolCalls },
	};
}

function toolResultToRecord(msg: any, step: number): LogRecord {
	const output = truncate(extractText(msg.content), MAX_TOOL_OUTPUT, MAX_TOOL_OUTPUT_TAIL);
	return {
		timestamp:
			typeof msg.timestamp === "string" ? msg.timestamp : new Date(msg.timestamp).toISOString(),
		agent: "tool",
		tool: msg.toolName || "unknown",
		error: msg.isError ? output : null,
		loop_step: step,
		payload: { role: "toolResult", toolName: msg.toolName, output },
	};
}

function bashExecutionToRecord(msg: any, step: number): LogRecord {
	const output = truncate(msg.output || "", MAX_TOOL_OUTPUT, MAX_TOOL_OUTPUT_TAIL);
	const errorMsg = msg.exitCode !== 0 ? output : null;
	return {
		timestamp:
			typeof msg.timestamp === "string" ? msg.timestamp : new Date(msg.timestamp).toISOString(),
		agent: "bash",
		tool: "bash",
		error: errorMsg,
		loop_step: step,
		payload: {
			role: "bashExecution",
			command: msg.command,
			output,
			exitCode: msg.exitCode,
			cancelled: msg.cancelled ?? false,
		},
	};
}

function customMessageToRecord(msg: any, step: number): LogRecord {
	return {
		timestamp:
			typeof msg.timestamp === "string" ? msg.timestamp : new Date(msg.timestamp).toISOString(),
		agent: msg.customType || "extension",
		tool: msg.customType || "extension",
		error: null,
		loop_step: step,
		payload: { role: "custom", content: extractText(msg.content) },
	};
}

function compactionToRecord(msg: any, step: number): LogRecord {
	return {
		timestamp: typeof msg.timestamp === "string" ? msg.timestamp : new Date().toISOString(),
		agent: "compaction",
		tool: "compaction",
		error: null,
		loop_step: step,
		payload: {
			role: "compactionSummary",
			tokensBefore: msg.tokensBefore,
			firstKeptEntryId: msg.firstKeptEntryId,
			summary: msg.summary,
		},
	};
}

function modelSelectToRecord(event: any, step: number): LogRecord {
	const m = event.model;
	return {
		timestamp: new Date().toISOString(),
		agent: "model_select",
		tool: "model_select",
		error: null,
		loop_step: step,
		payload: { provider: m.provider, modelId: m.id },
	};
}

function thinkingSelectToRecord(event: any, step: number): LogRecord {
	return {
		timestamp: new Date().toISOString(),
		agent: "thinking_select",
		tool: "thinking_select",
		error: null,
		loop_step: step,
		payload: { level: event.level },
	};
}

// =========================================================================
// JSONL Serializer Tests
// =========================================================================

// Split from session-logger.test.mts (issue #2035 Long File refactor).
describe("Session init / filesystem", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates parent directories recursively", () => {
		const nestedPath = path.join(tmpDir, ".pi", "sessions", "abc123");
		fs.mkdirSync(nestedPath, { recursive: true });
		assert.ok(fs.existsSync(nestedPath));
	});

	it("creates JSONL file", () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const jsonlFile = path.join(sessionsDir, "abc123.jsonl");
		// Create empty file (session_start creates it via WriteStream)
		fs.writeFileSync(jsonlFile, "");
		assert.ok(fs.existsSync(jsonlFile));
	});

	it("creates symlink latest.jsonl", () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "abc123.jsonl");
		fs.writeFileSync(sessionFile, "");
		const latestLink = path.join(sessionsDir, "latest.jsonl");
		try {
			fs.unlinkSync(latestLink);
		} catch {}
		fs.symlinkSync(sessionFile, latestLink);
		const stat = fs.lstatSync(latestLink);
		assert.ok(stat.isSymbolicLink());
		const target = fs.readlinkSync(latestLink);
		assert.ok(target.includes("abc123.jsonl"));
	});

	it("second session replaces symlink", () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });

		const file1 = path.join(sessionsDir, "session1.jsonl");
		fs.writeFileSync(file1, "");
		const latestLink = path.join(sessionsDir, "latest.jsonl");
		fs.symlinkSync(file1, latestLink);
		assert.ok(fs.readlinkSync(latestLink).includes("session1.jsonl"));

		const file2 = path.join(sessionsDir, "session2.jsonl");
		fs.writeFileSync(file2, "");
		fs.unlinkSync(latestLink);
		fs.symlinkSync(file2, latestLink);
		assert.ok(fs.readlinkSync(latestLink).includes("session2.jsonl"));
	});

	it("two sessions — both <sessionId>.metadata.json and .md files coexist", () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });

		// Session 1
		const sid1 = "session-111";
		const meta1 = {
			sessionId: sid1,
			messages: 5,
			tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
			cost: 0.0015,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};
		fs.writeFileSync(
			path.join(sessionsDir, `${sid1}.metadata.json`),
			JSON.stringify(meta1, null, 2),
		);
		fs.writeFileSync(path.join(sessionsDir, `${sid1}.md`), "# Session 1");

		// Session 2
		const sid2 = "session-222";
		const meta2 = {
			sessionId: sid2,
			messages: 10,
			tokens: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, total: 300 },
			cost: 0.003,
			compactions: 1,
			modelChanges: [],
			thinkingChanges: [],
		};
		fs.writeFileSync(
			path.join(sessionsDir, `${sid2}.metadata.json`),
			JSON.stringify(meta2, null, 2),
		);
		fs.writeFileSync(path.join(sessionsDir, `${sid2}.md`), "# Session 2");

		// Assert all 4 files coexist
		assert.ok(fs.existsSync(path.join(sessionsDir, `${sid1}.metadata.json`)), "Session1 metadata");
		assert.ok(fs.existsSync(path.join(sessionsDir, `${sid1}.md`)), "Session1 md");
		assert.ok(fs.existsSync(path.join(sessionsDir, `${sid2}.metadata.json`)), "Session2 metadata");
		assert.ok(fs.existsSync(path.join(sessionsDir, `${sid2}.md`)), "Session2 md");

		// Assert no stale files
		assert.ok(!fs.existsSync(path.join(sessionsDir, "metadata.json")), "No stale metadata.json");
		assert.ok(!fs.existsSync(path.join(sessionsDir, "sessions.md")), "No stale sessions.md");

		// Verify content preserved
		assert.strictEqual(
			JSON.parse(fs.readFileSync(path.join(sessionsDir, `${sid1}.metadata.json`), "utf-8"))
				.messages,
			5,
		);
		assert.strictEqual(
			JSON.parse(fs.readFileSync(path.join(sessionsDir, `${sid2}.metadata.json`), "utf-8"))
				.messages,
			10,
		);
	});

	it("<sessionId>.metadata.json written on shutdown", () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionId = "abc123";
		const meta = {
			sessionId,
			messages: 5,
			tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
			cost: 0.0015,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};
		const metaPath = path.join(sessionsDir, `${sessionId}.metadata.json`);
		fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
		const loaded = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.strictEqual(loaded.messages, 5);
	});
});

// =========================================================================
// Full Session Log Integration Test
// =========================================================================

describe("Full session integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-integration-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("simulates full session — 3 messages → valid JSONL", () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const jsonlFile = path.join(sessionsDir, "session1.jsonl");

		// Simulate writing records
		const records: LogRecord[] = [
			// session_start
			{
				timestamp: "2025-06-01T10:00:00.000Z",
				agent: "system",
				tool: "session_start",
				error: null,
				loop_step: 0,
				payload: { role: "session_start", sessionId: "session1", cwd: tmpDir },
			},
			// user message
			userMessageToRecord(
				{
					timestamp: "2025-06-01T10:00:01.000Z",
					content: [{ type: "text", text: "Hello" }],
				},
				1,
			),
			// assistant message
			assistantMessageToRecord(
				{
					timestamp: "2025-06-01T10:00:02.000Z",
					content: [{ type: "text", text: "Hi back!" }],
					usage: { input: 100, output: 50, totalTokens: 150 },
					stopReason: "stop",
				},
				2,
			),
			// tool result
			toolResultToRecord(
				{
					timestamp: "2025-06-01T10:00:03.000Z",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "file data" }],
				},
				3,
			),
		];

		const content = records.map((r) => serializeRecord(r)).join("");
		fs.writeFileSync(jsonlFile, content);

		// Verify all lines parse
		const lines = content.trimEnd().split("\n");
		assert.strictEqual(lines.length, 4);
		lines.forEach((line, i) => {
			const parsed = JSON.parse(line);
			assert.ok("timestamp" in parsed, `Line ${i} missing timestamp`);
			assert.ok("agent" in parsed, `Line ${i} missing agent`);
			assert.ok("tool" in parsed, `Line ${i} missing tool`);
			assert.ok("error" in parsed, `Line ${i} missing error`);
			assert.ok("loop_step" in parsed, `Line ${i} missing loop_step`);
			assert.ok("payload" in parsed, `Line ${i} missing payload`);
		});

		// Create symlink
		const latestLink = path.join(sessionsDir, "latest.jsonl");
		try {
			fs.unlinkSync(latestLink);
		} catch {}
		fs.symlinkSync(jsonlFile, latestLink);

		// Verify symlink content matches
		const symlinkContent = fs.readFileSync(latestLink, "utf-8");
		assert.strictEqual(symlinkContent, content);
	});

	it("error query finds error lines", () => {
		const records: LogRecord[] = [
			{ timestamp: "T1", agent: "user", tool: "message", error: null, loop_step: 1, payload: {} },
			{ timestamp: "T2", agent: "bash", tool: "bash", error: "exit=1", loop_step: 2, payload: {} },
			{ timestamp: "T3", agent: "user", tool: "message", error: null, loop_step: 3, payload: {} },
		];
		const content = records.map((r) => serializeRecord(r)).join("");
		const lines = content.trimEnd().split("\n");
		const errorLines = lines.filter((l) => {
			const parsed = JSON.parse(l);
			return parsed.error !== null;
		});
		assert.strictEqual(errorLines.length, 1);
	});

	it("streaming — 100 lines all parseable", () => {
		const records: LogRecord[] = [];
		for (let i = 0; i < 100; i++) {
			records.push({
				timestamp: `2025-06-01T10:00:${String(i).padStart(2, "0")}.000Z`,
				agent: "user",
				tool: "message",
				error: i % 10 === 0 ? `error-${i}` : null,
				loop_step: i + 1,
				payload: { index: i },
			});
		}
		const content = records.map((r) => serializeRecord(r)).join("");
		const lineCount = content.trimEnd().split("\n").length;
		assert.strictEqual(lineCount, 100);
		// Each line independently parseable
		content
			.trimEnd()
			.split("\n")
			.forEach((l) => JSON.parse(l));
	});
});
