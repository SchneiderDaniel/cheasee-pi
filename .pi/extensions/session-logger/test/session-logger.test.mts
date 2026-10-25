/**
 * Tests for .pi/extensions/session-logger.ts — JSONL Format
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger.test.mts
 */

import assert from "node:assert";

import { describe, it } from "node:test";

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
