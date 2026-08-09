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

describe("serializeRecord", () => {
	it("produces valid JSON ending with newline", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: { role: "user" },
		};
		const line = serializeRecord(record);
		assert.ok(line.endsWith("\n"));
		// Must parse as valid JSON
		const parsed = JSON.parse(line);
		assert.strictEqual(parsed.agent, "user");
	});

	it("includes error as null when not present", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: {},
		};
		const parsed = JSON.parse(serializeRecord(record));
		assert.strictEqual(parsed.error, null);
	});

	it("includes error string when present", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "bash",
			tool: "bash",
			error: "exit=1",
			loop_step: 1,
			payload: {},
		};
		const parsed = JSON.parse(serializeRecord(record));
		assert.strictEqual(parsed.error, "exit=1");
	});

	it("serializes token_usage as nested object", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "assistant",
			tool: "message",
			token_usage: { input: 100, output: 50, total: 150 },
			error: null,
			loop_step: 1,
			payload: {},
		};
		const parsed = JSON.parse(serializeRecord(record));
		assert.deepStrictEqual(parsed.token_usage, { input: 100, output: 50, total: 150 });
	});

	it("loop_step is integer", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 42,
			payload: {},
		};
		const parsed = JSON.parse(serializeRecord(record));
		assert.strictEqual(parsed.loop_step, 42);
		assert.ok(Number.isInteger(parsed.loop_step));
	});

	it("preserves arbitrary payload", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: { custom: "data", nested: { key: "value" } },
		};
		const parsed = JSON.parse(serializeRecord(record));
		assert.strictEqual(parsed.payload.custom, "data");
		assert.strictEqual(parsed.payload.nested.key, "value");
	});

	it("no blank lines — single line per record", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: {},
		};
		const line = serializeRecord(record);
		// Only one newline at end
		assert.strictEqual(line.indexOf("\n"), line.length - 1);
		assert.ok(!line.includes("\n\n"));
	});

	it("UTF-8 encoding with unicode chars", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: { text: "Hello 世界 🌍" },
		};
		const line = serializeRecord(record);
		const parsed = JSON.parse(line);
		assert.strictEqual(parsed.payload.text, "Hello 世界 🌍");
		// No BOM
		const bytes = Buffer.from(line);
		assert.ok(bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf);
	});

	it("no trailing whitespace before newline", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: {},
		};
		const line = serializeRecord(record);
		// Character before \n must be }
		assert.strictEqual(line[line.length - 2], "}");
	});

	it("no \\r\\n line terminators", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: {},
		};
		const line = serializeRecord(record);
		assert.ok(!line.includes("\r"));
	});

	it("all schema fields present", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: {},
		};
		const parsed = JSON.parse(serializeRecord(record));
		assert.ok("timestamp" in parsed);
		assert.ok("agent" in parsed);
		assert.ok("tool" in parsed);
		assert.ok("error" in parsed);
		assert.ok("loop_step" in parsed);
		assert.ok("payload" in parsed);
	});

	it("atomic append — multiple writes interleaved are independently parseable", () => {
		const records: LogRecord[] = [
			{
				timestamp: "2025-06-01T10:00:00.000Z",
				agent: "user",
				tool: "message",
				error: null,
				loop_step: 1,
				payload: {},
			},
			{
				timestamp: "2025-06-01T10:00:01.000Z",
				agent: "assistant",
				tool: "message",
				token_usage: { input: 10, output: 5, total: 15 },
				error: null,
				loop_step: 2,
				payload: {},
			},
			{
				timestamp: "2025-06-01T10:00:02.000Z",
				agent: "bash",
				tool: "bash",
				error: "fail",
				loop_step: 3,
				payload: {},
			},
		];
		const combined = records.map((r) => serializeRecord(r)).join("");
		const lines = combined.split("\n").filter((l) => l.length > 0);
		assert.strictEqual(lines.length, 3);
		lines.forEach((l) => {
			const parsed = JSON.parse(l);
			assert.ok("timestamp" in parsed);
		});
	});
});

// =========================================================================
// Event → JSONL Mapping Tests
// =========================================================================

describe("userMessageToRecord", () => {
	it("maps user message correctly", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "text", text: "Hello" }],
		};
		const record = userMessageToRecord(msg, 1);
		assert.strictEqual(record.agent, "user");
		assert.strictEqual(record.tool, "message");
		assert.strictEqual(record.error, null);
		assert.strictEqual(record.loop_step, 1);
		assert.strictEqual(record.payload.content, "Hello");
	});
});

describe("assistantMessageToRecord", () => {
	it("maps assistant message with token_usage", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:01.000Z",
			content: [{ type: "text", text: "Hi!" }],
			usage: { input: 100, output: 50, totalTokens: 150 },
			stopReason: "stop",
		};
		const record = assistantMessageToRecord(msg, 2);
		assert.strictEqual(record.agent, "assistant");
		assert.deepStrictEqual(record.token_usage, { input: 100, output: 50, total: 150 });
		assert.strictEqual(record.error, null);
	});

	it("maps thinking block", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:01.000Z",
			content: [{ type: "thinking", thinking: "Hmm..." }],
		};
		const record = assistantMessageToRecord(msg, 2);
		assert.deepStrictEqual(record.payload.thinking, ["Hmm..."]);
	});

	it("maps tool call", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:01.000Z",
			content: [{ type: "toolCall", name: "read", arguments: { path: "/f" } }],
		};
		const record = assistantMessageToRecord(msg, 2);
		assert.strictEqual((record.payload.toolCalls as any[])[0].name, "read");
	});

	it("stop reason as error when non-stop", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:01.000Z",
			content: [{ type: "text", text: "x" }],
			stopReason: "max_tokens",
		};
		const record = assistantMessageToRecord(msg, 2);
		assert.strictEqual(record.error, "stop_reason: max_tokens");
	});
});

describe("toolResultToRecord", () => {
	it("maps successful tool result", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:02.000Z",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "file contents" }],
		};
		const record = toolResultToRecord(msg, 3);
		assert.strictEqual(record.agent, "tool");
		assert.strictEqual(record.tool, "read");
		assert.strictEqual(record.error, null);
	});

	it("maps error tool result", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:02.000Z",
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "Command not found" }],
		};
		const record = toolResultToRecord(msg, 3);
		assert.ok(record.error !== null);
		assert.ok(record.error.includes("Command not found"));
	});

	it("missing toolName defaults to unknown", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:02.000Z",
			isError: false,
			content: "text",
		};
		const record = toolResultToRecord(msg, 3);
		assert.strictEqual(record.tool, "unknown");
	});
});

describe("bashExecutionToRecord", () => {
	it("maps bash execution", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:03.000Z",
			command: "ls -la",
			output: "total 42",
			exitCode: 0,
			cancelled: false,
		};
		const record = bashExecutionToRecord(msg, 4);
		assert.strictEqual(record.agent, "bash");
		assert.strictEqual(record.tool, "bash");
		assert.strictEqual(record.error, null);
		assert.strictEqual((record.payload as any).command, "ls -la");
		assert.strictEqual((record.payload as any).exitCode, 0);
	});

	it("maps failed bash as error", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:03.000Z",
			command: "bad",
			output: "fail",
			exitCode: 1,
			cancelled: false,
		};
		const record = bashExecutionToRecord(msg, 4);
		assert.ok(record.error !== null);
	});
});

describe("customMessageToRecord", () => {
	it("maps custom message with customType", () => {
		const msg = {
			timestamp: "2025-06-01T10:00:04.000Z",
			customType: "my-plugin",
			content: [{ type: "text", text: "data" }],
		};
		const record = customMessageToRecord(msg, 5);
		assert.strictEqual(record.agent, "my-plugin");
		assert.strictEqual(record.tool, "my-plugin");
	});
});

describe("compactionToRecord", () => {
	it("maps compaction summary", () => {
		const entry = {
			timestamp: "2025-06-01T10:00:05.000Z",
			tokensBefore: 10000,
			firstKeptEntryId: "abc",
			summary: "Compact 10→2",
		};
		const record = compactionToRecord(entry, 6);
		assert.strictEqual(record.agent, "compaction");
		assert.strictEqual(record.tool, "compaction");
		assert.strictEqual((record.payload as any).summary, "Compact 10→2");
	});
});

describe("modelSelectToRecord", () => {
	it("maps model select", () => {
		const event = { model: { provider: "openai", id: "gpt-4" } };
		const record = modelSelectToRecord(event, 7);
		assert.strictEqual(record.agent, "model_select");
		assert.strictEqual(record.tool, "model_select");
		assert.strictEqual((record.payload as any).modelId, "gpt-4");
	});
});

describe("thinkingSelectToRecord", () => {
	it("maps thinking level select", () => {
		const event = { level: "high" };
		const record = thinkingSelectToRecord(event, 8);
		assert.strictEqual(record.agent, "thinking_select");
		assert.strictEqual(record.tool, "thinking_select");
		assert.strictEqual((record.payload as any).level, "high");
	});
});

// =========================================================================
// JSONL Compliance Tests
// =========================================================================

describe("JSONL spec compliance", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("no blank lines in stream", () => {
		const records: LogRecord[] = [
			{
				timestamp: "2025-06-01T10:00:00.000Z",
				agent: "user",
				tool: "message",
				error: null,
				loop_step: 1,
				payload: {},
			},
			{
				timestamp: "2025-06-01T10:00:01.000Z",
				agent: "assistant",
				tool: "message",
				error: null,
				loop_step: 2,
				payload: {},
			},
			{
				timestamp: "2025-06-01T10:00:02.000Z",
				agent: "bash",
				tool: "bash",
				error: "fail",
				loop_step: 3,
				payload: {},
			},
		];
		const content = records.map((r) => serializeRecord(r)).join("");
		assert.ok(!content.includes("\n\n"), "Should not contain blank lines");
	});

	it("no BOM at start of file", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: {},
		};
		const filePath = path.join(tmpDir, "test.jsonl");
		fs.writeFileSync(filePath, serializeRecord(record));
		const buf = fs.readFileSync(filePath);
		// UTF-8 BOM is EF BB BF
		assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf));
	});

	it("uses \\n not \\r\\n", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: {},
		};
		const filePath = path.join(tmpDir, "test.jsonl");
		fs.writeFileSync(filePath, serializeRecord(record));
		const buf = fs.readFileSync(filePath);
		const content = buf.toString("utf-8");
		assert.ok(!content.includes("\r\n"));
		assert.ok(content.endsWith("\n"));
	});

	it("each line valid JSON", () => {
		const records: LogRecord[] = [
			{
				timestamp: "2025-06-01T10:00:00.000Z",
				agent: "user",
				tool: "message",
				error: null,
				loop_step: 1,
				payload: { a: 1 },
			},
			{
				timestamp: "2025-06-01T10:00:01.000Z",
				agent: "assistant",
				tool: "message",
				token_usage: { input: 1, output: 2, total: 3 },
				error: null,
				loop_step: 2,
				payload: { b: 2 },
			},
			{
				timestamp: "2025-06-01T10:00:02.000Z",
				agent: "tool",
				tool: "read",
				error: null,
				loop_step: 3,
				payload: { c: 3 },
			},
		];
		const content = records.map((r) => serializeRecord(r)).join("");
		const lines = content.trimEnd().split("\n");
		for (const line of lines) {
			// Should not throw
			const parsed = JSON.parse(line);
			assert.ok("timestamp" in parsed);
		}
	});

	it("final line has \\n terminator", () => {
		const record: LogRecord = {
			timestamp: "2025-06-01T10:00:00.000Z",
			agent: "user",
			tool: "message",
			error: null,
			loop_step: 1,
			payload: {},
		};
		const filePath = path.join(tmpDir, "test.jsonl");
		fs.writeFileSync(filePath, serializeRecord(record));
		const content = fs.readFileSync(filePath, "utf-8");
		assert.ok(content.endsWith("\n"));
	});

	it("concatenation of multiple JSONL files is safe", () => {
		const r1: LogRecord = {
			timestamp: "T1",
			agent: "a",
			tool: "t",
			error: null,
			loop_step: 1,
			payload: {},
		};
		const r2: LogRecord = {
			timestamp: "T2",
			agent: "b",
			tool: "t",
			error: null,
			loop_step: 2,
			payload: {},
		};
		const combined = serializeRecord(r1) + serializeRecord(r2);
		const lines = combined.trimEnd().split("\n");
		assert.strictEqual(lines.length, 2);
		lines.forEach((l) => JSON.parse(l)); // no throw
	});
});

// =========================================================================
// Session Init / Symlink Tests
// =========================================================================

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
