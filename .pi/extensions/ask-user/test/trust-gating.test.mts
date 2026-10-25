import assert from "node:assert";

import fs from "node:fs";

import path from "node:path";

import os from "node:os";

import { describe, it, beforeEach, afterEach } from "node:test";

import { appendQnaEntry } from "../jsonl-logger.ts";

import askUser from "../index.ts";

interface MockPi {
	registerTool: (tool: any) => void;
	on: (event: string, handler: any) => void;
	registerCommand: (name: string, cmd: any) => void;
	sendUserMessage: (msg: string, opts?: any) => void;
}

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

		const parsed = result.structuredContent;
		assert.deepStrictEqual(parsed.entries, []);
		assert.strictEqual(parsed.count, 0);
		assert.strictEqual(parsed.trustGranted, false, "structured content marks trust denied");
		assert.ok(
			parsed.message?.includes("not available") || parsed.message?.includes("not granted"),
			"Message should indicate Q&A is unavailable",
		);

		assert.strictEqual(result.isError, true, "trust-denied result is an error");
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

		const parsed = result.structuredContent;
		assert.strictEqual(parsed.count, 2);
		assert.strictEqual(parsed.entries.length, 2);
		assert.strictEqual(parsed.total, 2, "list payload must carry total history size");
		assert.ok(!result.isError, "successful read is not an error");
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

		const parsed = result.structuredContent;
		assert.deepStrictEqual(parsed.entries, []);
		assert.strictEqual(parsed.count, 0);
		assert.strictEqual(parsed.trustGranted, false);
		assert.strictEqual(result.isError, true);
		assert.strictEqual(result.details.untrusted, true);
	});

	it("returns empty result with untrusted flag for query action when untrusted", async () => {
		const execute = tools["ask_user_read"].execute;
		const result: any = await execute("call1", { action: "query", text: "test" }, null, null, {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => false,
		});

		const parsed = result.structuredContent;
		assert.deepStrictEqual(parsed.entries, []);
		assert.strictEqual(parsed.count, 0);
		assert.strictEqual(parsed.trustGranted, false);
		assert.strictEqual(result.isError, true);
		assert.strictEqual(result.details.untrusted, true);
	});
});
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
