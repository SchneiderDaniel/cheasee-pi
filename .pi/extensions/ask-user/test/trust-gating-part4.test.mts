import assert from "node:assert";

import fs from "node:fs";

import path from "node:path";

import os from "node:os";

import { describe, it, beforeEach, afterEach } from "node:test";

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

describe("ask_user_read storage error passthrough (Issue #1777)", () => {
	let tmpDir: string;
	let tools: Record<string, any>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-eisdir-"));
		const { mockPi, tools: t } = makeMockPi();
		tools = t;
		askUser(mockPi as any);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("a directory at qna.jsonl rejects with the original EISDIR error", async () => {
		// Deliberately create a directory where the JSONL file is expected.
		fs.mkdirSync(path.join(tmpDir, ".pi", "context", "qna.jsonl"), { recursive: true });

		await assert.rejects(
			tools["ask_user_read"].execute("call1", { action: "list" }, null, null, {
				sessionManager: { getCwd: () => tmpDir },
				isProjectTrusted: async () => true,
			}),
			(err: any) => {
				assert.strictEqual(err.code, "EISDIR", "original fs error code preserved");
				return true;
			},
		);
	});

	it("cancel contract is unchanged: no aborted marker in ask_user cancel structuredContent", async () => {
		const execute = tools["ask_user"].execute;
		const result: any = await execute(
			"call1",
			{ mode: "choice", question: "Pick:", options: [{ label: "A", value: "a" }] },
			null,
			null,
			{
				mode: "json",
				sessionManager: { getCwd: () => tmpDir },
				isProjectTrusted: async () => true,
				ui: {
					input: async () => undefined,
					custom: async () => undefined,
					select: async () => undefined,
					notify: () => {},
				},
			},
		);

		assert.strictEqual(result.structuredContent.cancelled, true);
		assert.ok(!("aborted" in result.structuredContent));
		assert.strictEqual(
			result.content[0].text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});
});
