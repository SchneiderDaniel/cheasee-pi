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

describe("handler — mode-adaptive notification", () => {
	it("TUI mode → notify for format + lint, followUp for diagnostics", async () => {
		const { notifyCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: true }) } as Formatter,
			{
				canHandle: () => true,
				lint: async () => ({
					diagnostics: [
						{
							file: "test.ts",
							line: 5,
							column: 1,
							severity: "Warning" as const,
							message: "warn",
							ruleId: "no-warn",
						},
					],
					fixesApplied: false,
				}),
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.ok(
				notifyCalls.some((m) => m.startsWith("Formatted:")),
				"TUI format notify",
			);
			assert.ok(
				notifyCalls.some((m) => m.startsWith("Lint ran:")),
				"TUI lint notify",
			);
			assert.ok(
				sendUserMessages.some((m) => m.content.includes("Lint Diagnostics")),
				"lint diagnostic followUp sent",
			);
		} finally {
			cleanup();
		}
	});
	it("TUI mode, lint empty diagnostics → no followUp", async () => {
		const { notifyCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: true }) } as Formatter,
			{
				canHandle: () => true,
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.ok(
				notifyCalls.some((m) => m.startsWith("Formatted:")),
				"TUI format notify",
			);
			assert.ok(
				notifyCalls.some((m) => m.startsWith("Lint ran:")),
				"TUI lint notify",
			);
			assert.strictEqual(
				sendUserMessages.filter((m) => m.content.includes("Lint Diagnostics")).length,
				0,
				"no followUp when lint has no diagnostics",
			);
		} finally {
			cleanup();
		}
	});
	it("RPC mode → sendUserMessage for format + lint, no ctx.ui.notify", async () => {
		const { notifyCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: true }) } as Formatter,
			{
				canHandle: () => true,
				lint: async () => ({
					diagnostics: [
						{
							file: "test.ts",
							line: 5,
							column: 1,
							severity: "Error" as const,
							message: "err",
							ruleId: "no-err",
						},
					],
					fixesApplied: false,
				}),
			} as Linter,
			{},
			{ mode: "rpc" },
		);
		try {
			assert.strictEqual(notifyCalls.length, 0, "RPC no notify");
			assert.ok(
				sendUserMessages.some((m) => m.content.startsWith("Formatted:")),
				"RPC format followUp",
			);
			assert.ok(
				sendUserMessages.some((m) => m.content.includes("Lint Diagnostics")),
				"RPC lint followUp",
			);
		} finally {
			cleanup();
		}
	});
	it("JSON mode → no format notification/followUp, lint followUp still sent", async () => {
		const { notifyCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: true }) } as Formatter,
			{
				canHandle: () => true,
				lint: async () => ({
					diagnostics: [
						{
							file: "test.ts",
							line: 5,
							column: 1,
							severity: "Error" as const,
							message: "err",
							ruleId: "no-err",
						},
					],
					fixesApplied: false,
				}),
			} as Linter,
			{},
			{ mode: "json" },
		);
		try {
			assert.strictEqual(notifyCalls.length, 0, "JSON no notify");
			assert.strictEqual(
				sendUserMessages.filter((m) => m.content.startsWith("Formatted:")).length,
				0,
				"JSON no format followUp",
			);
			assert.ok(
				sendUserMessages.some((m) => m.content.includes("Lint Diagnostics")),
				"JSON lint followUp still sent",
			);
		} finally {
			cleanup();
		}
	});
});
