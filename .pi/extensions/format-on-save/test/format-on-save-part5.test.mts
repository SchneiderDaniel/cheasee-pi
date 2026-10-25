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

describe("handler — format notifications", () => {
	it("format success in TUI mode → ctx.ui.notify called", async () => {
		const { notifyCalls, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: true }) } as Formatter,
			{
				canHandle: () => false,
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.ok(
				notifyCalls.some((m) => m.startsWith("Formatted:")),
				"TUI should notify formatted",
			);
		} finally {
			cleanup();
		}
	});

	it("format no-change → no notification", async () => {
		const { notifyCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: false }) } as Formatter,
			{
				canHandle: () => false,
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.strictEqual(notifyCalls.length, 0, "no notification when format returns no change");
			assert.strictEqual(
				sendUserMessages.length,
				0,
				"no sendUserMessage when format returns no change",
			);
		} finally {
			cleanup();
		}
	});

	it("format error → notification in TUI mode", async () => {
		const { notifyCalls, consoleErrorCalls, cleanup } = await runHandlerWithMocks(
			{
				canHandle: () => true,
				format: async () => ({ formatted: false, error: "write error" }),
			} as Formatter,
			{
				canHandle: () => false,
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.ok(
				notifyCalls.some((m) => m.startsWith("Format failed:")),
				"TUI should notify format error",
			);
			assert.ok(
				consoleErrorCalls.some((m) => m.includes("write error")),
				"should log error to console",
			);
		} finally {
			cleanup();
		}
	});

	it("format success in RPC mode → sendUserMessage", async () => {
		const { notifyCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: true }) } as Formatter,
			{
				canHandle: () => false,
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			} as Linter,
			{},
			{ mode: "rpc" },
		);
		try {
			assert.strictEqual(notifyCalls.length, 0, "RPC should not call ctx.ui.notify");
			assert.ok(
				sendUserMessages.some((m) => m.content.startsWith("Formatted:")),
				"RPC should send format success via sendUserMessage",
			);
		} finally {
			cleanup();
		}
	});

	it("format success in JSON mode → no notification, no followUp", async () => {
		const { notifyCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: true }) } as Formatter,
			{
				canHandle: () => false,
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			} as Linter,
			{},
			{ mode: "json" },
		);
		try {
			assert.strictEqual(notifyCalls.length, 0, "JSON mode should not notify");
			assert.strictEqual(
				sendUserMessages.filter((m) => m.content.startsWith("Formatted:")).length,
				0,
				"JSON mode should not send format followUp",
			);
		} finally {
			cleanup();
		}
	});

	it("format success in print mode → same as json", async () => {
		const { notifyCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: true }) } as Formatter,
			{
				canHandle: () => false,
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			} as Linter,
			{},
			{ mode: "print" },
		);
		try {
			assert.strictEqual(notifyCalls.length, 0, "Print mode should not notify");
			assert.strictEqual(
				sendUserMessages.filter((m) => m.content.startsWith("Formatted:")).length,
				0,
				"Print mode should not send format followUp",
			);
		} finally {
			cleanup();
		}
	});

	it("format throws → handler catches and logs, does not crash", async () => {
		const { consoleErrorCalls, notifyCalls, cleanup } = await runHandlerWithMocks(
			{
				canHandle: () => true,
				format: async () => {
					throw new Error("format crash");
				},
			} as Formatter,
			{
				canHandle: () => false,
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.ok(
				consoleErrorCalls.some((m) => m.includes("formatter threw")),
				"should log formatter throw",
			);
			assert.strictEqual(
				notifyCalls.filter((m) => m.startsWith("Formatted:") || m.startsWith("Format failed:"))
					.length,
				0,
				"no format notification when formatter throws",
			);
		} finally {
			cleanup();
		}
	});
});
