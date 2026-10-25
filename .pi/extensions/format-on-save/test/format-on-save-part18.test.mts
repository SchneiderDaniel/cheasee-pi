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

describe("PrettierFormatter — serialised RMW (issue #1901)", () => {
	it("acquires the queue exactly once, with the target path", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const queue = createFakeQueue();
		const mockPrettier = {
			format: async () => "const x = 1;\n",
			resolveConfig: async () => ({}),
		};
		const mockFs = { readFile: async () => "const x = 1\n", writeFile: async () => {} };
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any, queue);
		(f as any).plugins = [];
		await f.format("/path/file.ts");
		assert.deepStrictEqual(queue.paths, ["/path/file.ts"]);
	});
	it("resolves config and loads plugins before the lock; reads and writes inside it", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const queue = createFakeQueue();
		const mockPrettier = {
			resolveConfig: async () => {
				queue.log.push("config");
				return {};
			},
			format: async () => {
				queue.log.push("format");
				return "const x = 1;\n";
			},
		};
		const mockFs = {
			readFile: async () => {
				queue.log.push(queue.state.inLock ? "read:locked" : "read:unlocked");
				return "const x = 1\n";
			},
			writeFile: async () => {
				queue.log.push(queue.state.inLock ? "write:locked" : "write:unlocked");
			},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any, queue);
		(f as any).ensurePlugins = async () => {
			queue.log.push("plugin");
			return [];
		};
		await f.format("/path/file.ts");
		assert.deepStrictEqual(queue.log, [
			"config",
			"plugin",
			"lock:enter",
			"read:locked",
			"format",
			"write:locked",
			"lock:exit",
		]);
	});
	it("lost update: newer content queued through the same queue survives", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const { dir, file } = makeTempFile("fos-prettier-lost-", "const   x   =   1;\n");
		const newer = "const x = 1;\nconst fromNextTurn = 2;\n";
		const gate = createGate();
		let formatStarted!: () => void;
		const started = new Promise<void>((r) => {
			formatStarted = r;
		});
		const queue = createFakeQueue();
		const mockPrettier = {
			resolveConfig: async () => ({}),
			format: async () => {
				formatStarted();
				await gate.wait;
				return "const x = 1;\n"; // prettier's stale snapshot
			},
		};
		const realFs = {
			readFile: async (p: string) => readFileSync(p, "utf-8"),
			writeFile: async (p: string, c: string) => {
				writeFileSync(p, c, "utf-8");
			},
		};
		const f = new PrettierFormatter(dir, mockPrettier as any, realFs as any, queue);
		(f as any).plugins = [];
		const pending = f.format(file);
		await started; // formatter holds the lock, parked inside format()
		const edit = queue.withLock(file, async () => {
			writeFileSync(file, newer, "utf-8");
		});
		gate.open();
		const result = await pending;
		await edit;
		assert.deepStrictEqual(result, { formatted: true });
		assert.strictEqual(readFileSync(file, "utf-8"), newer, "newer edit must win");
		rmSync(dir, { recursive: true, force: true });
	});
	it("skips the write and reports formatted=false when prettier returns source unchanged", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const source = "const x = 1;\n";
		const queue = createFakeQueue();
		let writes = 0;
		const mockPrettier = { format: async () => source, resolveConfig: async () => ({}) };
		const mockFs = {
			readFile: async () => source,
			writeFile: async () => {
				writes++;
			},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any, queue);
		(f as any).plugins = [];
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, false);
		assert.strictEqual(result.error, undefined);
		assert.strictEqual(writes, 0, "unchanged file must not be written");
	});
	it("surfaces prettier failure and never writes", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const queue = createFakeQueue();
		let writes = 0;
		const mockPrettier = {
			resolveConfig: async () => ({}),
			format: async () => {
				throw new Error("parse error");
			},
		};
		const mockFs = {
			readFile: async () => "const x = 1\n",
			writeFile: async () => {
				writes++;
			},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any, queue);
		(f as any).plugins = [];
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, false);
		assert.ok(result.error?.includes("parse error"));
		assert.strictEqual(writes, 0);
	});
	it("fail-closed: a rejecting queue surfaces an error and performs no write", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		let writes = 0;
		const queue: FileMutationQueue = {
			withLock: async () => {
				throw new Error("queue unavailable");
			},
		};
		const mockPrettier = { format: async () => "const x = 1;\n", resolveConfig: async () => ({}) };
		const mockFs = {
			readFile: async () => "const x = 1\n",
			writeFile: async () => {
				writes++;
			},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any, queue);
		(f as any).plugins = [];
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, false);
		assert.ok(result.error?.includes("queue unavailable"), "queue error must surface");
		assert.strictEqual(writes, 0);
	});
});
describe("PrettierFormatter — serialised RMW (issue #1901)", () => {
	it("releases the lock when format() throws (next format completes)", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const queue = createFakeQueue();
		let call = 0;
		const mockPrettier = {
			resolveConfig: async () => ({}),
			format: async () => {
				call++;
				if (call === 1) throw new Error("boom");
				return "const x = 1;\n";
			},
		};
		const mockFs = { readFile: async () => "const x = 1\n", writeFile: async () => {} };
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any, queue);
		(f as any).plugins = [];
		const first = await f.format("/path/file.ts");
		assert.ok(first.error, "first call errors");
		const second = await f.format("/path/file.ts");
		assert.deepStrictEqual(second, { formatted: true });
	});
});
