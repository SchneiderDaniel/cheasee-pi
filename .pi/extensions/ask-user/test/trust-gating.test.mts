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
		assert.strictEqual(parsed.total, 2, "list payload must carry total history size");
		assert.deepStrictEqual(
			parsed.entries.map((e: any) => e.id),
			[1, 2],
			"list payload entries must carry absolute ids",
		);

		assert.strictEqual(result.details.format, "qna-result-v1");
		assert.strictEqual(result.details.count, 2);
		assert.strictEqual(result.details.total, 2);
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

// ============================================================================
// Tests: list/get absolute ids across /qna and ask_user_read (issue #1614)
// ============================================================================

describe("list/get absolute ids (issue #1614)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-abs-adapter-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Append N entries; optional marker prefix for specific positions. */
	async function appendN(n: number, marker?: (i: number) => string): Promise<void> {
		for (let i = 1; i <= n; i++) {
			const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
			await appendQnaEntry(tmpDir, ts, `${marker ? marker(i) : ""}Entry ${i}`, `Answer ${i}`);
		}
	}

	async function makeFixture(): Promise<{
		commands: Record<string, any>;
		messages: Array<{ msg: string; opts?: any }>;
		tools: Record<string, any>;
		ctx: any;
	}> {
		const { mockPi, commands, messages, tools } = makeMockPi();
		askUser(mockPi as any);
		const ctx = {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => true,
		};
		return { commands, messages, tools, ctx };
	}

	it("/qna list with 30 entries renders absolute ids + total footer", async () => {
		await appendN(30);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list", ctx);

		const msg = messages[0]!.msg;
		assert.ok(
			msg.includes("| 11 | 2026-01-01T00:00:11.000Z | Entry 11 | Answer 11 |"),
			"row 1 should be labeled with absolute id 11",
		);
		assert.ok(
			msg.includes("| 30 | 2026-01-01T00:00:30.000Z | Entry 30 | Answer 30 |"),
			"last row should be labeled with absolute id 30",
		);
		assert.ok(msg.includes("Showing #11–#30 of 30"), "footer must show sliced range and total");
	});

	it("/qna list with fewer entries than limit → ids 1..N and full footer", async () => {
		await appendN(3);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list", ctx);

		const msg = messages[0]!.msg;
		assert.ok(msg.includes("| 1 | 2026-01-01T00:00:01.000Z | Entry 1 | Answer 1 |"));
		assert.ok(msg.includes("| 3 | 2026-01-01T00:00:03.000Z | Entry 3 | Answer 3 |"));
		assert.ok(msg.includes("Showing #1–#3 of 3"), "footer always rendered when list succeeds");
	});

	it("/qna list empty log → no history message, no table, no footer", async () => {
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list", ctx);

		assert.strictEqual(messages[0]!.msg, "No Q&A history yet.");
		assert.ok(!messages[0]!.msg.includes("Showing #"), "no footer for empty log");
	});

	it("/qna search rows carry absolute match ids and roundtrip through get", async () => {
		await appendN(26, (i) => (i === 5 || i === 20 ? "needle " : ""));
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("search needle", ctx);

		const msg = messages[0]!.msg;
		assert.ok(msg.includes("| 5 | 2026-01-01T00:00:05.000Z | needle Entry 5 | Answer 5 |"));
		assert.ok(msg.includes("| 20 | 2026-01-01T00:00:20.000Z | needle Entry 20 | Answer 20 |"));

		// Displayed id roundtrips through get (shared root cause with list)
		messages.length = 0;
		await commands["qna"].handler("get 5", ctx);
		assert.ok(messages[0]!.msg.includes("needle Entry 5"), "get returns the search-row question");
		assert.ok(messages[0]!.msg.includes("Answer 5"), "get returns the search-row answer");
	});

	it("regression: --limit parse (custom honored, invalid falls back to 20)", async () => {
		await appendN(30);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list --limit 5", ctx);
		assert.ok(
			messages[0]!.msg.includes("Showing #26–#30 of 30"),
			"custom limit 5 should show last 5 entries",
		);

		messages.length = 0;
		await commands["qna"].handler("list --limit abc", ctx);
		assert.ok(
			messages[0]!.msg.includes("Showing #11–#30 of 30"),
			"invalid limit falls back to default 20",
		);
	});

	it("ask_user_read list payload: per-entry ids, count and total (truncated)", async () => {
		await appendN(25);
		const { tools, ctx } = await makeFixture();

		const result: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "list", limit: 20 },
			null,
			null,
			ctx,
		);

		const parsed = JSON.parse(result.content[0]!.text);
		assert.strictEqual(parsed.count, 20);
		assert.strictEqual(parsed.total, 25, "payload carries full history size");
		assert.deepStrictEqual(
			parsed.entries.map((e: any) => e.id),
			Array.from({ length: 20 }, (_, i) => i + 6),
			"ids are absolute (6..25 for last 20 of 25)",
		);
		for (const e of parsed.entries) {
			assert.ok(typeof e.id === "number" && e.datetime && e.question && e.answer);
		}
		assert.strictEqual(result.details.total, 25);
	});

	it("ask_user_read fractional limit → integer ids, list-then-get roundtrip", async () => {
		await appendN(30);
		const { tools, ctx } = await makeFixture();

		// QnaReadParams.limit is Type.Number, so a fractional value reaches
		// listQnaEntries; it must be truncated to an integer so payload ids
		// are integral and resolve through get.
		const listResult: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "list", limit: 1.5 },
			null,
			null,
			ctx,
		);
		const listed = JSON.parse(listResult.content[0]!.text);
		assert.strictEqual(listed.count, 1, "trunc(1.5) = 1 entry");
		assert.ok(Number.isInteger(listed.entries[0]!.id), "payload id must be an integer");
		assert.strictEqual(listed.entries[0]!.id, 30);

		const getResult: any = await tools["ask_user_read"].execute(
			"call2",
			{ action: "get", id: listed.entries[0]!.id },
			null,
			null,
			ctx,
		);
		const got = JSON.parse(getResult.content[0]!.text);
		assert.strictEqual(got.entries[0]!.question, "Entry 30");
		assert.strictEqual(got.entries[0]!.answer, "Answer 30");
	});

	it("ask_user_read query payload: matched entries carry absolute ids", async () => {
		await appendN(26, (i) => (i === 5 || i === 20 ? "needle " : ""));
		const { tools, ctx } = await makeFixture();

		const result: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "query", text: "needle" },
			null,
			null,
			ctx,
		);

		const parsed = JSON.parse(result.content[0]!.text);
		assert.strictEqual(parsed.count, 2, "count == number of matches");
		assert.deepStrictEqual(
			parsed.entries.map((e: any) => e.id),
			[5, 20],
			"query results keep absolute ids",
		);
	});

	it("ask_user_read get payload unchanged; list-then-get roundtrip with payload ids", async () => {
		await appendN(30);
		const { tools, ctx } = await makeFixture();

		const listResult: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "list", limit: 5 },
			null,
			null,
			ctx,
		);
		const listed = JSON.parse(listResult.content[0]!.text);
		assert.strictEqual(listed.entries.length, 5);
		const firstId: number = listed.entries[0]!.id;
		assert.strictEqual(firstId, 26, "first of last 5 of 30");

		const getResult: any = await tools["ask_user_read"].execute(
			"call2",
			{ action: "get", id: firstId },
			null,
			null,
			ctx,
		);
		const got = JSON.parse(getResult.content[0]!.text);
		assert.strictEqual(got.count, 1);
		assert.strictEqual(got.entries[0]!.datetime, "2026-01-01T00:00:26.000Z");
		assert.strictEqual(got.entries[0]!.question, "Entry 26");
		assert.strictEqual(got.entries[0]!.answer, "Answer 26");
		assert.ok(!("id" in got.entries[0]), "get payload entry shape has no id (unchanged)");
	});

	it("human journey: displayed row id → /qna get returns same question/answer", async () => {
		await appendN(30);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list", ctx);
		assert.ok(
			messages[0]!.msg.includes("| 11 | 2026-01-01T00:00:11.000Z | Entry 11 | Answer 11 |"),
		);

		messages.length = 0;
		await commands["qna"].handler("get 11", ctx);
		assert.ok(messages[0]!.msg.includes("Entry 11"), "get shows the row-11 question");
		assert.ok(messages[0]!.msg.includes("Answer 11"), "get shows the row-11 answer");
	});

	it("regression: get 0 → usage; get 999 → not found; context-dir-as-file → error surfaced", async () => {
		await appendN(5);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("get 0", ctx);
		assert.ok(messages[0]!.msg.includes("positive number"), "id < 1 shows usage");

		messages.length = 0;
		await commands["qna"].handler("get 999", ctx);
		assert.strictEqual(messages[0]!.msg, "Entry #999 not found.");

		// .pi/context replaced by a regular file → list error surfaces
		messages.length = 0;
		const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-abs-file-"));
		try {
			await fs.promises.mkdir(path.join(fileDir, ".pi"), { recursive: true });
			await fs.promises.writeFile(path.join(fileDir, ".pi", "context"), "not a dir", "utf-8");
			const fileCtx = {
				sessionManager: { getCwd: () => fileDir },
				isProjectTrusted: async () => true,
			};
			await commands["qna"].handler("list", fileCtx);
			assert.ok(
				messages[0]!.msg.startsWith("Error reading Q&A history"),
				`list error surfaced, got: ${messages[0]!.msg}`,
			);
		} finally {
			fs.rmSync(fileDir, { recursive: true, force: true });
		}
	});
});
