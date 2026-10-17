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
