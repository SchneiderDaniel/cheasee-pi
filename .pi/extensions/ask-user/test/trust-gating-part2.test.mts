import assert from "node:assert";

import fs from "node:fs";

import path from "node:path";

import os from "node:os";

import { describe, it, beforeEach, afterEach } from "node:test";

import { appendQnaEntry, readQnaEntries } from "../jsonl-logger.ts";

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
