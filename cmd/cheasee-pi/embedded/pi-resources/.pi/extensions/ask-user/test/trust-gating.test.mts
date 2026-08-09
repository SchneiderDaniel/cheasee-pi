/**
 * Use-case layer tests for trust-gated Q&A history + structured response format (Issue #740).
 *
 * Tests that Q&A history reads/writes/migration are gated on ctx.isProjectTrusted()
 * and that tool response details include the "qna-result-v1" format discriminator.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/trust-gating.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import { appendQnaEntry, readQnaEntries, migrateIfCsvExists } from "../jsonl-logger.ts";
import askUser from "../index.ts";

// ---------------------------------------------------------------------------
// Mock pi API helper
// ---------------------------------------------------------------------------

interface MockPi {
	registerTool: (tool: any) => void;
	on: (event: string, handler: any) => void;
	registerCommand: (name: string, cmd: any) => void;
	sendUserMessage: (msg: string, opts?: any) => void;
}

/** Container for session_start handler (mutable reference for mock capture). */
interface SessionHandlerHolder {
	handler: ((event: string, ctx: any) => Promise<void>) | null;
}

function makeMockPi(): {
	mockPi: MockPi;
	tools: Record<string, any>;
	commands: Record<string, any>;
	sessionHandlerHolder: SessionHandlerHolder;
	messages: Array<{ msg: string; opts?: any }>;
} {
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const messages: Array<{ msg: string; opts?: any }> = [];
	const sessionHandlerHolder: SessionHandlerHolder = { handler: null };

	const mockPi: MockPi = {
		registerTool: (tool: any) => {
			tools[tool.name] = tool;
		},
		on: (event: string, handler: any) => {
			if (event === "session_start") {
				sessionHandlerHolder.handler = handler;
			}
		},
		registerCommand: (name: string, cmd: any) => {
			commands[name] = cmd;
		},
		sendUserMessage: (msg: string, opts?: any) => {
			messages.push({ msg, opts });
		},
	};

	return { mockPi, tools, commands, sessionHandlerHolder, messages };
}

// ============================================================================
// Tests: session_start trust gating
// ============================================================================

describe("session_start trust gating", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-trust-session-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("skips CSV migration when isProjectTrusted() returns false", async () => {
		// Set up CSV fixture
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		fs.writeFileSync(path.join(csvDir, "qna.csv"), "2026-05-15T19:00:00.000Z;Q1;A1", "utf-8");

		const { mockPi, sessionHandlerHolder } = makeMockPi();
		askUser(mockPi as any);

		assert.ok(sessionHandlerHolder.handler !== null, "session_start handler should be registered");

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		await sessionHandlerHolder.handler!("session_start", {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => false,
		});

		console.warn = origWarn;

		// CSV should NOT have been migrated — it should still exist
		assert.ok(
			fs.existsSync(path.join(csvDir, "qna.csv")),
			"CSV should still exist when migration skipped",
		);
		// JSONL should NOT exist
		assert.ok(
			!fs.existsSync(path.join(csvDir, "qna.jsonl")),
			"JSONL should not be created when migration skipped",
		);
		// A warning should have been logged
		assert.ok(
			warnings.some((w) => w.includes("skipped") || w.includes("not granted")),
			"Warning should mention migration skipped or trust not granted",
		);
	});

	it("runs CSV migration when isProjectTrusted() returns true", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		fs.writeFileSync(path.join(csvDir, "qna.csv"), "2026-05-15T19:00:00.000Z;Q1;A1", "utf-8");

		const { mockPi, sessionHandlerHolder } = makeMockPi();
		askUser(mockPi as any);

		await sessionHandlerHolder.handler!("session_start", {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => true,
		});

		// CSV should have been migrated
		assert.ok(!fs.existsSync(path.join(csvDir, "qna.csv")), "CSV should be gone after migration");
		// JSONL should exist with migrated entry
		assert.ok(fs.existsSync(path.join(csvDir, "qna.jsonl")), "JSONL should exist after migration");
	});
});

// ============================================================================
// Tests: ask_user_read trust gating
// ============================================================================

describe("ask_user_read trust gating", () => {
	let tmpDir: string;
	let tools: Record<string, any>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-trust-read-"));
		const { mockPi, tools: t } = makeMockPi();
		tools = t;
		askUser(mockPi as any);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty result with untrusted flag when !isProjectTrusted()", async () => {
		const execute = tools["ask_user_read"].execute;
		const result: any = await execute("call1", { action: "list" }, null, null, {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => false,
		});

		const parsed = JSON.parse(result.content[0]!.text);
		assert.deepStrictEqual(parsed.entries, []);
		assert.strictEqual(parsed.count, 0);
		assert.ok(
			parsed.message?.includes("not available") || parsed.message?.includes("not granted"),
			"Message should indicate Q&A is unavailable",
		);

		assert.strictEqual(result.details.format, "qna-result-v1");
		assert.strictEqual(result.details.untrusted, true);
		assert.deepStrictEqual(result.details.entries, []);
		assert.strictEqual(result.details.count, 0);
	});

	it("returns actual entries when isProjectTrusted() returns true", async () => {
		// Write entries first
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		await appendQnaEntry(tmpDir, "2026-05-15T20:00:00.000Z", "Q2", "A2");

		const execute = tools["ask_user_read"].execute;
		const result: any = await execute("call1", { action: "list" }, null, null, {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => true,
		});

		const parsed = JSON.parse(result.content[0]!.text);
		assert.strictEqual(parsed.count, 2);
		assert.strictEqual(parsed.entries.length, 2);

		assert.strictEqual(result.details.format, "qna-result-v1");
		assert.strictEqual(result.details.count, 2);
		assert.ok(!result.details.untrusted, "untrusted flag should not be present when trusted");
	});

	it("returns empty result with untrusted flag for get action when untrusted", async () => {
		const execute = tools["ask_user_read"].execute;
		const result: any = await execute("call1", { action: "get", id: 1 }, null, null, {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => false,
		});

		const parsed = JSON.parse(result.content[0]!.text);
		assert.deepStrictEqual(parsed.entries, []);
		assert.strictEqual(parsed.count, 0);
		assert.strictEqual(result.details.untrusted, true);
	});

	it("returns empty result with untrusted flag for query action when untrusted", async () => {
		const execute = tools["ask_user_read"].execute;
		const result: any = await execute("call1", { action: "query", text: "test" }, null, null, {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => false,
		});

		const parsed = JSON.parse(result.content[0]!.text);
		assert.deepStrictEqual(parsed.entries, []);
		assert.strictEqual(parsed.count, 0);
		assert.strictEqual(result.details.untrusted, true);
	});
});

// ============================================================================
// Tests: /qna trust gating
// ============================================================================

describe("/qna trust gating", () => {
	let tmpDir: string;
	let commands: Record<string, any>;
	let messages: Array<{ msg: string; opts?: any }>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-trust-qna-"));
		const { mockPi, commands: c, messages: m } = makeMockPi();
		commands = c;
		messages = m;
		askUser(mockPi as any);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("shows explanation message when not trusted (list)", async () => {
		const cmd = commands["qna"];
		await cmd.handler("list", {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => false,
			mode: "tui",
		});

		assert.strictEqual(messages.length, 1);
		assert.ok(
			messages[0]!.msg.includes("not available") || messages[0]!.msg.includes("not granted"),
			"Message should indicate Q&A is unavailable",
		);
		assert.strictEqual(messages[0]!.opts?.deliverAs, "followUp");
	});

	it("shows explanation message when not trusted (get)", async () => {
		const cmd = commands["qna"];
		await cmd.handler("get 1", {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => false,
		});

		assert.strictEqual(messages.length, 1);
		assert.ok(
			messages[0]!.msg.includes("not available") || messages[0]!.msg.includes("not granted"),
		);
	});

	it("shows explanation message when not trusted (search)", async () => {
		const cmd = commands["qna"];
		await cmd.handler("search test", {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => false,
		});

		assert.strictEqual(messages.length, 1);
		assert.ok(
			messages[0]!.msg.includes("not available") || messages[0]!.msg.includes("not granted"),
		);
	});

	it("returns entries normally when trusted", async () => {
		// Write entries
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		await appendQnaEntry(tmpDir, "2026-05-15T20:00:00.000Z", "Q2", "A2");

		const cmd = commands["qna"];
		await cmd.handler("list", {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => true,
		});

		// Should have output about entries, not about trust
		assert.ok(messages.length > 0, "Should have output (entries or 'no history')");
		// Message should NOT say unavailable
		assert.ok(
			!messages[0]!.msg.includes("not available"),
			"Message should not say unavailable when trusted",
		);
	});
});

// ============================================================================
// Tests: successResult / ask_user_read response details format
// ============================================================================

describe("successResult / ask_user_read response format", () => {
	let tmpDir: string;
	let tools: Record<string, any>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-format-test-"));
		const { mockPi, tools: t } = makeMockPi();
		tools = t;
		askUser(mockPi as any);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("ask_user_read response details includes format: qna-result-v1 discriminator", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");

		const execute = tools["ask_user_read"].execute;
		const result: any = await execute("call1", { action: "list" }, null, null, {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => true,
		});

		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("ask_user_read untrusted response details includes untrusted: true and format discriminator", async () => {
		const execute = tools["ask_user_read"].execute;
		const result: any = await execute("call1", { action: "list" }, null, null, {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => false,
		});

		assert.strictEqual(result.details.format, "qna-result-v1");
		assert.strictEqual(result.details.untrusted, true);
	});
});

// ============================================================================
// Tests: ask_user tool response details format
// ============================================================================

describe("ask_user tool response format", () => {
	let tmpDir: string;
	let tools: Record<string, any>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-ask-format-"));
		const { mockPi, tools: t } = makeMockPi();
		tools = t;
		askUser(mockPi as any);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("ask_user choice response details includes format: qna-result-v1", async () => {
		const execute = tools["ask_user"].execute;
		let capturedDone: ((value: string | undefined) => void) | undefined;

		const resultPromise = execute(
			"call1",
			{
				mode: "choice",
				question: "Pick one:",
				options: [
					{ label: "A", value: "a" },
					{ label: "B", value: "b" },
				],
			},
			null,
			null,
			{
				sessionManager: { getCwd: () => tmpDir },
				mode: "tui",
				ui: {
					// We need custom to return a value for choice mode
					custom: async <T,>() => {
						return new Promise<T>((resolve) => {
							capturedDone = (value: string | undefined) => resolve(value as T);
						});
					},
					input: async () => "",
					select: async () => undefined,
					notify: () => {},
				},
				isProjectTrusted: async () => true,
			},
		);

		capturedDone!("1. A");
		const result: any = await resultPromise;

		assert.strictEqual(result.details.format, "qna-result-v1");
		assert.strictEqual(result.details.selected, "a");
	});

	it("ask_user freetext response details includes format: qna-result-v1", async () => {
		const execute = tools["ask_user"].execute;
		const result: any = await execute(
			"call1",
			{
				mode: "freetext",
				question: "Say something:",
			},
			null,
			null,
			{
				sessionManager: { getCwd: () => tmpDir },
				mode: "tui",
				ui: {
					input: async () => "my answer",
					custom: async () => undefined,
					select: async () => undefined,
					notify: () => {},
				},
				isProjectTrusted: async () => true,
			},
		);

		assert.strictEqual(result.details.format, "qna-result-v1");
		assert.strictEqual(result.details.answer, "my answer");
	});

	it("ask_user cancel response details includes format: qna-result-v1", async () => {
		const execute = tools["ask_user"].execute;
		const result: any = await execute(
			"call1",
			{
				mode: "freetext",
				question: "Say something:",
			},
			null,
			null,
			{
				sessionManager: { getCwd: () => tmpDir },
				mode: "json", // JSON mode → cancel without UI
				ui: {
					input: async () => undefined,
					custom: async () => undefined,
					select: async () => undefined,
					notify: () => {},
				},
				isProjectTrusted: async () => true,
			},
		);

		assert.strictEqual(result.details.format, "qna-result-v1");
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});
});

// ============================================================================
// Tests: Integration — combined mode + trust scenarios
// ============================================================================

describe("Integration — combined mode + trust scenarios", () => {
	let tmpDir: string;
	let tools: Record<string, any>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-integration-"));
		const { mockPi, tools: t } = makeMockPi();
		tools = t;
		askUser(mockPi as any);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("RPC mode + untrusted: answer returned, no entry written to JSONL, details include format", async () => {
		const execute = tools["ask_user"].execute;
		const result: any = await execute(
			"call1",
			{
				mode: "freetext",
				question: "What is your quest?",
			},
			null,
			null,
			{
				sessionManager: { getCwd: () => tmpDir },
				mode: "rpc",
				ui: {
					input: async () => "To seek the Holy Grail",
					custom: async () => undefined,
					select: async () => undefined,
					notify: () => {},
				},
				isProjectTrusted: async () => false,
			},
		);

		// Answer returned in content
		assert.strictEqual(result.content[0]?.text, 'User answered: "To seek the Holy Grail"');
		assert.strictEqual(result.details.answer, "To seek the Holy Grail");
		assert.strictEqual(result.details.format, "qna-result-v1");

		// No entry should have been written to JSONL
		const entries = await readQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 0, "Should not write entry when untrusted");
	});

	it("JSON mode + trusted: cancelResponse, no UI calls, no JSONL write", async () => {
		const execute = tools["ask_user"].execute;
		const result: any = await execute(
			"call1",
			{
				mode: "choice",
				question: "Pick one:",
				options: [{ label: "A", value: "a" }],
			},
			null,
			null,
			{
				sessionManager: { getCwd: () => tmpDir },
				mode: "json",
				ui: {
					input: async () => {
						throw new Error("should not be called");
					},
					custom: async () => {
						throw new Error("should not be called");
					},
					select: async () => {
						throw new Error("should not be called");
					},
					notify: () => {},
				},
				isProjectTrusted: async () => true,
			},
		);

		assert.strictEqual(result.details.format, "qna-result-v1");
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);

		// No entry should have been written
		const entries = await readQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 0, "Cancel should not write entry");
	});

	it("RPC mode + trusted + freetext: answer typed, entry written to JSONL", async () => {
		const execute = tools["ask_user"].execute;
		const result: any = await execute(
			"call1",
			{
				mode: "freetext",
				question: "What is your favorite color?",
			},
			null,
			null,
			{
				sessionManager: { getCwd: () => tmpDir },
				mode: "rpc",
				ui: {
					input: async () => "Blue",
					custom: async () => undefined,
					select: async () => undefined,
					notify: () => {},
				},
				isProjectTrusted: async () => true,
			},
		);

		assert.strictEqual(result.details.answer, "Blue");
		assert.strictEqual(result.details.format, "qna-result-v1");

		// Entry should have been written
		const entries = await readQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.question, "What is your favorite color?");
		assert.strictEqual(entries[0]!.answer, "Blue");
	});

	it("Boundary: isProjectTrusted() returns false then true across calls", async () => {
		// First call: untrusted — no write
		const execute = tools["ask_user"].execute;
		await execute("call1", { mode: "freetext", question: "Q1?" }, null, null, {
			sessionManager: { getCwd: () => tmpDir },
			mode: "tui",
			ui: {
				input: async () => "A1",
				custom: async () => undefined,
				select: async () => undefined,
				notify: () => {},
			},
			isProjectTrusted: async () => false,
		});

		let entries = await readQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 0, "No entry when untrusted");

		// Second call: trusted — should write
		await execute("call2", { mode: "freetext", question: "Q2?" }, null, null, {
			sessionManager: { getCwd: () => tmpDir },
			mode: "tui",
			ui: {
				input: async () => "A2",
				custom: async () => undefined,
				select: async () => undefined,
				notify: () => {},
			},
			isProjectTrusted: async () => true,
		});

		entries = await readQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 1, "Should have 1 entry after trusted call");
		assert.strictEqual(entries[0]!.question, "Q2?");
		assert.strictEqual(entries[0]!.answer, "A2");
	});
});

// ============================================================================
// Tests: jsonl-logger defensive trust parameter
// ============================================================================

describe("jsonl-logger defensive trust parameter", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-defensive-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("appendQnaEntry with trusted=false skips write and returns entry", async () => {
		const entry = await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1", false);

		assert.strictEqual(entry.question, "Q1");
		assert.strictEqual(entry.answer, "A1");

		// No file should exist
		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		assert.ok(!fs.existsSync(jsonlPath), "JSONL should not exist when trusted=false");
	});

	it("appendQnaEntry with trusted=true writes normally", async () => {
		const entry = await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1", true);

		assert.strictEqual(entry.question, "Q1");

		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		assert.ok(fs.existsSync(jsonlPath), "JSONL should exist when trusted=true");
	});

	it("appendQnaEntry with trusted=undefined writes normally (backward compat)", async () => {
		const entry = await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");

		assert.strictEqual(entry.question, "Q1");

		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		assert.ok(fs.existsSync(jsonlPath), "JSONL should exist when trusted is undefined");
	});

	it("appendQnaEntry still validates even when trusted=false", async () => {
		await assert.rejects(() => appendQnaEntry(tmpDir, "bad-date", "Q1", "A1", false), /Datetime/);
	});
});
