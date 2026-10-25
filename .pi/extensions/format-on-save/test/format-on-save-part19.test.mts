import assert from "node:assert";

import { describe, it } from "node:test";

import { registerHandler } from "../index.ts";

import type {
	Formatter,
	Linter,
	FormatResult,
	LintResult,
	Diagnostic,
	FileMutationQueue,
} from "../ports.mts";

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";

import { join } from "node:path";

import { tmpdir } from "node:os";

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

function createMockFormatter(results?: { canHandle?: boolean; format?: FormatResult }): {
	mock: Formatter;
	calls: { canHandle: string[]; format: string[] };
} {
	const calls = { canHandle: [] as string[], format: [] as string[] };
	const mockFormatter: Formatter = {
		canHandle(path: string) {
			calls.canHandle.push(path);
			return results?.canHandle ?? true;
		},
		async format(path: string) {
			calls.format.push(path);
			return results?.format ?? { formatted: true };
		},
	};
	return { mock: mockFormatter, calls };
}

function createMockLinter(results?: { canHandle?: boolean; lint?: LintResult }): {
	mock: Linter;
	calls: { canHandle: string[]; lint: string[] };
} {
	const calls = { canHandle: [] as string[], lint: [] as string[] };
	const mockLinter: Linter = {
		canHandle(path: string) {
			calls.canHandle.push(path);
			return results?.canHandle ?? true;
		},
		async lint(path: string) {
			calls.lint.push(path);
			return results?.lint ?? { diagnostics: [], fixesApplied: false };
		},
	};
	return { mock: mockLinter, calls };
}

function createTempTsFile(): { dir: string; filePath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "fos-handler-test-"));
	const filePath = join(dir, "test.ts");
	writeFileSync(filePath, "const x = 1;\n");
	return { dir, filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function createMockAPI(): {
	pi: ExtensionAPI;
	events: Array<{ event: string; handler: (...args: unknown[]) => unknown }>;
	sendUserMessages: Array<{ content: string; options: Record<string, unknown> }>;
} {
	const events: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
	const sendUserMessages: Array<{ content: string; options: Record<string, unknown> }> = [];

	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			events.push({ event, handler });
		},
		sendUserMessage: (content: string, options: Record<string, unknown>) => {
			sendUserMessages.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	return { pi, events, sendUserMessages };
}

async function runHandler(
	overrides: {
		mockFormatter?: Formatter;
		mockLinter?: Linter;
		eventOverrides?: Partial<ToolResultEvent>;
		ctxOverrides?: Record<string, unknown>;
		notifyCalls?: string[];
	} = {},
): Promise<{
	formatterCalls: { canHandle: string[]; format: string[] };
	linterCalls: { canHandle: string[]; lint: string[] };
	sendUserMessages: Array<{ content: string; options: Record<string, unknown> }>;
	notifyCalls: string[];
	consoleErrorCalls: string[];
	cleanup: () => void;
}> {
	const { dir, filePath, cleanup } = createTempTsFile();
	const notifyCalls: string[] = [];
	const consoleErrorCalls: string[] = [];

	const formatterData = createMockFormatter();
	const linterData = createMockLinter();

	const formatter = overrides.mockFormatter ?? formatterData.mock;
	const linter = overrides.mockLinter ?? linterData.mock;

	const { pi, events, sendUserMessages } = createMockAPI();

	// Stub console.error to capture calls
	const origConsoleError = console.error;
	console.error = (...args: unknown[]) => {
		consoleErrorCalls.push(args.map(String).join(" "));
	};

	try {
		registerHandler(pi, formatter, linter);

		const toolResult = events.find((e) => e.event === "tool_result");
		assert.ok(toolResult !== undefined, "tool_result handler must be registered");

		const ctx = {
			cwd: dir,
			ui: {
				notify: (message: string, _type?: string) => {
					notifyCalls.push(message);
				},
				setStatus: () => {},
				theme: { fg: () => (s: string) => s, bold: (s: string) => s },
			} as unknown as ExtensionUIContext,
			sessionManager: { getEntries: () => [] as unknown[] },
			mode: "tui",
			hasUI: true,
			isProjectTrusted: () => true,
			...overrides.ctxOverrides,
		} as unknown as ExtensionContext;

		const event = {
			toolName: "write",
			isError: false,
			type: "tool_result",
			toolCallId: "test-call",
			input: { path: "test.ts" },
			content: [],
			...overrides.eventOverrides,
		} as unknown as ToolResultEvent;

		await toolResult.handler(event, ctx);

		return {
			formatterCalls: formatterData.calls,
			linterCalls: linterData.calls,
			sendUserMessages,
			notifyCalls,
			consoleErrorCalls,
			cleanup,
		};
	} finally {
		console.error = origConsoleError;
		cleanup();
	}
}

async function runHandlerWithMocks(
	formatter: Formatter,
	linter: Linter,
	eventOverrides: Partial<ToolResultEvent> = {},
	ctxOverrides: Record<string, unknown> = {},
): Promise<{
	sendUserMessages: Array<{ content: string; options: Record<string, unknown> }>;
	notifyCalls: string[];
	consoleErrorCalls: string[];
	cleanup: () => void;
}> {
	const { dir, cleanup } = createTempTsFile();
	const notifyCalls: string[] = [];
	const consoleErrorCalls: string[] = [];

	const { pi, events, sendUserMessages } = createMockAPI();

	const origConsoleError = console.error;
	console.error = (...args: unknown[]) => {
		consoleErrorCalls.push(args.map(String).join(" "));
	};

	try {
		registerHandler(pi, formatter, linter);

		const toolResult = events.find((e) => e.event === "tool_result");
		assert.ok(toolResult !== undefined);

		const ctx = {
			cwd: dir,
			ui: {
				notify: (message: string, _type?: string) => {
					notifyCalls.push(message);
				},
				setStatus: () => {},
				theme: { fg: () => (s: string) => s, bold: (s: string) => s },
			} as unknown as ExtensionUIContext,
			sessionManager: { getEntries: () => [] as unknown[] },
			mode: "tui",
			hasUI: true,
			isProjectTrusted: () => true,
			...ctxOverrides,
		} as unknown as ExtensionContext;

		const event = {
			toolName: "write",
			isError: false,
			type: "tool_result",
			toolCallId: "test-call",
			input: { path: "test.ts" },
			content: [],
			...eventOverrides,
		} as unknown as ToolResultEvent;

		await toolResult.handler(event, ctx);

		return { sendUserMessages, notifyCalls, consoleErrorCalls, cleanup };
	} finally {
		console.error = origConsoleError;
		cleanup();
	}
}

function createBrokenConfigFixture(): {
	dir: string;
	jsFile: string;
	tsFile: string;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "fos-eslint-fallback-"));
	writeFileSync(join(dir, "eslint.config.mjs"), "export default [");
	const jsFile = join(dir, "a.js");
	writeFileSync(jsFile, "const x = 1;\n");
	const tsFile = join(dir, "a.ts");
	writeFileSync(tsFile, "const x: number = 1;\n");
	return { dir, jsFile, tsFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withCwd(dir: string, fn: () => Promise<unknown>): Promise<unknown> {
	const oldCwd = process.cwd();
	process.chdir(dir);
	try {
		return await fn();
	} finally {
		process.chdir(oldCwd);
	}
}

type QueueFake = FileMutationQueue & {
	log: string[];
	paths: string[];
	state: { inLock: boolean };
};

function createFakeQueue(): QueueFake {
	const log: string[] = [];
	const paths: string[] = [];
	const state = { inLock: false };
	let tail: Promise<unknown> = Promise.resolve();
	return {
		log,
		paths,
		state,
		async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
			paths.push(path);
			const prev = tail;
			let release!: () => void;
			tail = new Promise<void>((r) => {
				release = r;
			});
			await prev;
			log.push("lock:enter");
			state.inLock = true;
			try {
				return await fn();
			} finally {
				state.inLock = false;
				log.push("lock:exit");
				release();
			}
		},
	};
}

function createGate(): { wait: Promise<void>; open: () => void } {
	let open!: () => void;
	const wait = new Promise<void>((r) => {
		open = r;
	});
	return { wait, open };
}

function settle(): Promise<void> {
	return new Promise<void>((r) => setTimeout(r, 25));
}

function makeTempFile(prefix: string, content: string): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const file = join(dir, "a.ts");
	writeFileSync(file, content, "utf-8");
	return { dir, file };
}

describe("EslintLinter — serialised fix-write (issue #1901)", () => {
	it("acquires the queue exactly once, with the target path", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const queue = createFakeQueue();
		const mockESLint = async () => ({
			lintText: async () => [{ filePath: "/path/file.ts", messages: [] }],
		});
		const l = new EslintLinter(mockESLint as any, queue);
		(l as any).readFile = async () => "const x = 1;\n";
		await l.lint("/path/file.ts");
		assert.deepStrictEqual(queue.paths, ["/path/file.ts"]);
	});

	it("reads the file while the lock is held", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const queue = createFakeQueue();
		let inLockAtRead = false;
		const mockESLint = async () => ({
			lintText: async () => [{ filePath: "/path/file.ts", messages: [] }],
		});
		const l = new EslintLinter(mockESLint as any, queue);
		(l as any).readFile = async () => {
			inLockAtRead = queue.state.inLock;
			return "const x = 1;\n";
		};
		await l.lint("/path/file.ts");
		assert.strictEqual(inLockAtRead, true, "read must happen inside the lock");
	});

	it("lost update: newer content queued through the same queue survives the fix-write", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const { dir, file } = makeTempFile("fos-eslint-lost-", "old;\n");
		const newer = "new;\nconst fromNextTurn = 2;\n";
		const gate = createGate();
		let lintStarted!: () => void;
		const started = new Promise<void>((r) => {
			lintStarted = r;
		});
		const queue = createFakeQueue();
		const mockESLint = async () => ({
			lintText: async () => {
				lintStarted();
				await gate.wait;
				return [{ filePath: file, messages: [], output: "stale output\n" }];
			},
		});
		const l = new EslintLinter(mockESLint as any, queue);
		const pending = l.lint(file);
		await started;
		const edit = queue.withLock(file, async () => {
			writeFileSync(file, newer, "utf-8");
		});
		gate.open();
		const result = await pending;
		await edit;
		assert.strictEqual(result.fixesApplied, true);
		assert.strictEqual(readFileSync(file, "utf-8"), newer, "newer edit must win");
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not write when the result carries no output", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const queue = createFakeQueue();
		let writes = 0;
		const mockESLint = async () => ({
			lintText: async () => [
				{
					filePath: "/path/file.ts",
					messages: [{ line: 1, column: 1, severity: 1, message: "w", ruleId: null }],
				},
			],
		});
		const l = new EslintLinter(mockESLint as any, queue);
		(l as any).readFile = async () => "const x = 1;\n";
		(l as any).writeFile = async () => {
			writes++;
		};
		const result = await l.lint("/path/file.ts");
		assert.strictEqual(result.fixesApplied, false);
		assert.strictEqual(result.diagnostics.length, 1);
		assert.strictEqual(writes, 0);
	});

	it("does not write on a non-config error", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const queue = createFakeQueue();
		let writes = 0;
		const mockESLint = async () => ({
			lintText: async () => {
				throw { name: "TypeError", message: "Cannot read properties of undefined" };
			},
		});
		const l = new EslintLinter(mockESLint as any, queue);
		(l as any).readFile = async () => "const x = 1;\n";
		(l as any).writeFile = async () => {
			writes++;
		};
		const result = await l.lint("/path/file.ts");
		assert.ok(result.error?.includes("Cannot read properties"));
		assert.strictEqual(writes, 0);
	});

	it("config-error fallback still carries the original error", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const queue = createFakeQueue();
		const mockESLint = async () => ({
			lintText: async () => {
				throw { name: "ConfigError", message: "bad config" };
			},
		});
		const mockFallback = async () => ({
			lintText: async () => [{ filePath: "/path/file.ts", messages: [] }],
		});
		const l = new EslintLinter(mockESLint as any, queue);
		(l as any).readFile = async () => "const x = 1;\n";
		(l as any).createFallbackESLint = mockFallback;
		const result = await l.lint("/path/file.ts");
		assert.ok(result.error?.includes("bad config"));
		assert.strictEqual(result.fixesApplied, false);
	});

	it("default queue (1-arg ctor) still lints", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const mockESLint = async () => ({
			lintText: async () => [{ filePath: "/path/file.ts", messages: [] }],
		});
		const l = new EslintLinter(mockESLint as any);
		(l as any).readFile = async () => "const x = 1;\n";
		const result = await l.lint("/path/file.ts");
		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.diagnostics.length, 0);
	});
});
