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

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

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

describe("PrettierFormatter unit tests", () => {
	it("canHandle returns true for .ts files", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const f = new PrettierFormatter("/tmp");
		assert.strictEqual(f.canHandle("/path/file.ts"), true);
		assert.strictEqual(f.canHandle("/path/file.tsx"), true);
		assert.strictEqual(f.canHandle("/path/file.js"), true);
		assert.strictEqual(f.canHandle("/path/file.jsx"), true);
		assert.strictEqual(f.canHandle("/path/file.mjs"), true);
		assert.strictEqual(f.canHandle("/path/file.cjs"), true);
		assert.strictEqual(f.canHandle("/path/file.mts"), true);
		assert.strictEqual(f.canHandle("/path/file.cts"), true);
		assert.strictEqual(f.canHandle("/path/file.json"), true);
		assert.strictEqual(f.canHandle("/path/file.jsonc"), true);
		assert.strictEqual(f.canHandle("/path/file.json5"), true);
	});

	it("canHandle returns false for unsupported extensions", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const f = new PrettierFormatter("/tmp");
		assert.strictEqual(f.canHandle("/path/file.py"), false);
		assert.strictEqual(f.canHandle("/path/file.md"), false);
		assert.strictEqual(f.canHandle("/path/file.css"), false);
	});

	it("format returns error when prettier module throws", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const mockPrettier = {
			format: async () => {
				throw new Error("parse error");
			},
			resolveConfig: async () => ({ tabWidth: 2 }),
		};
		const mockFs = {
			readFile: async () => "const x = 1\n",
			writeFile: async () => {},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any);
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, false);
		assert.ok(result.error?.includes("parse error"), "should surface prettier error");
	});

	it("format returns formatted=false when no change needed", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const source = "const x = 1;\n";
		const mockPrettier = {
			format: async (_s: string, _o: Record<string, unknown>) => source,
			resolveConfig: async (_p: string) => ({ tabWidth: 2 }),
		};
		const mockFs = {
			readFile: async () => source,
			writeFile: async () => {},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any);
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, false);
		assert.strictEqual(result.error, undefined);
	});

	it("format returns formatted=true when change applied", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const mockPrettier = {
			format: async (_s: string, _o: Record<string, unknown>) => "const x = 1;\n",
			resolveConfig: async (_p: string) => ({ tabWidth: 2 }),
		};
		const mockFs = {
			readFile: async () => "const x = 1\n", // note: no semicolon in source
			writeFile: async () => {},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any);
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, true);
	});

	it("format returns error when fs.writeFile fails", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const source = "const x = 1\n";
		const mockPrettier = {
			format: async (_s: string, _o: Record<string, unknown>) => "const x = 1;\n",
			resolveConfig: async (_p: string) => ({ tabWidth: 2 }),
		};
		const mockFs = {
			readFile: async () => source,
			writeFile: async () => {
				throw new Error("ENOSPC: no space");
			},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any);
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, false);
		assert.ok(result.error?.includes("ENOSPC"), "should surface write error");
	});

	it("format resolves config from project root (root-only behavior)", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		let resolvedConfigPath = "";
		const mockPrettier = {
			format: async (_s: string, _o: Record<string, unknown>) => _s,
			resolveConfig: async (_p: string, opts: Record<string, unknown>) => {
				resolvedConfigPath = opts.config as string;
				return null;
			},
		};
		const mockFs = {
			readFile: async () => "const x = 1\n",
			writeFile: async () => {},
		};
		const f = new PrettierFormatter("/my/project", mockPrettier as any, mockFs as any);
		await f.format("/my/project/src/file.ts");
		assert.ok(
			resolvedConfigPath.endsWith("/my/project/.prettierrc"),
			"config should resolve from project root, not file's directory",
		);
	});

	it("format returns error when fs.readFile fails (ENOENT)", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		const mockPrettier = {
			format: async () => "",
			resolveConfig: async () => ({ tabWidth: 2 }),
		};
		const mockFs = {
			readFile: async () => {
				throw new Error("ENOENT: file not found");
			},
			writeFile: async () => {},
		};
		const f = new PrettierFormatter("/tmp", mockPrettier as any, mockFs as any);
		const result = await f.format("/path/file.ts");
		assert.strictEqual(result.formatted, false);
		assert.ok(result.error?.includes("ENOENT"), "should surface readFile error");
	});
});
