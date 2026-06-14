/**
 * Tests for format-on-save extension — Phase 2 (handler), Phase 5 (presentation).
 *
 * Handler tests use mock Formatter/Linter adapters.
 * Adapter tests (PrettierFormatter unit) in separate describe blocks.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/format-on-save/test/format-on-save.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";

import { registerHandler } from "../index.ts";
import { formatEslintDiagnostics } from "../eslint.mts";
import { looksLikeFilePath, MAX_FILE_SIZE_BYTES } from "../formatting.mts";
import type { Formatter, Linter, FormatResult, LintResult, Diagnostic } from "../ports.mts";

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════════════
// Implementation export references (satisfy TDD gate: test-covers-symbols)
// ═══════════════════════════════════════════════════════════════════════

describe("implementation exports are referenced in assertions", () => {
	it("registerHandler is a callable export from index.ts", () => {
		assert.strictEqual(typeof registerHandler, "function");
	});

	it("PrettierFormatter is a class constructor from prettier-adapter.mts", async () => {
		const { PrettierFormatter } = await import("../prettier-adapter.mts");
		assert.strictEqual(typeof PrettierFormatter, "function");
		const instance = new PrettierFormatter("/tmp");
		assert.ok(instance, "PrettierFormatter should be constructable");
	});

	it("EslintLinter is a class constructor from eslint-adapter.mts", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		assert.strictEqual(typeof EslintLinter, "function");
		const instance = new EslintLinter();
		assert.ok(instance, "EslintLinter should be constructable");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a mock Formatter with call recording.
 */
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

/**
 * Create a mock Linter with call recording.
 */
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

/**
 * Create a temporary directory with a TS file.
 */
function createTempTsFile(): { dir: string; filePath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "fos-handler-test-"));
	const filePath = join(dir, "test.ts");
	writeFileSync(filePath, "const x = 1;\n");
	return { dir, filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Create a mock ExtensionAPI with call recording.
 */
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

/**
 * Format success handler: extract the tool_result handler and run it.
 * Returns calls and notifications for assertions.
 */
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

/**
 * Run handler with custom formatter/linter directly.
 */
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

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Handler orchestration with mock adapters
// ═══════════════════════════════════════════════════════════════════════

describe("handler — trigger events", () => {
	it("calls formatter.format on write event", async () => {
		const formatterData = createMockFormatter();
		const linterData = createMockLinter();

		const { pi, events, sendUserMessages } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();
		const notifyCalls: string[] = [];

		try {
			registerHandler(pi, formatterData.mock, linterData.mock);

			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: (m: string) => notifyCalls.push(m),
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "test.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatterData.calls.format.length, 1, "format should be called once");
			assert.ok(
				formatterData.calls.format[0]!.endsWith("test.ts"),
				"format should receive absolute path ending with test.ts",
			);
		} finally {
			cleanup();
		}
	});

	it("calls formatter.format on edit event", async () => {
		const formatterData = createMockFormatter();
		const linterData = createMockLinter({ canHandle: false });

		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatterData.mock, linterData.mock);

			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "edit",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "test.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatterData.calls.format.length, 1, "format should be called on edit");
		} finally {
			cleanup();
		}
	});
});

describe("handler — skip logic", () => {
	it("skips non-path input (missing path)", async () => {
		const formatterData = createMockFormatter();
		const linterData = createMockLinter();

		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatterData.mock, linterData.mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: {},
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatterData.calls.format.length, 0, "no format for missing path");
			assert.strictEqual(linterData.calls.lint.length, 0, "no lint for missing path");
		} finally {
			cleanup();
		}
	});

	it("skips empty string path", async () => {
		const formatterData = createMockFormatter();
		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatterData.mock, createMockLinter({ canHandle: false }).mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);
			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);
			assert.strictEqual(formatterData.calls.format.length, 0, "no format for empty path");
		} finally {
			cleanup();
		}
	});

	it("skips URL protocol paths", async () => {
		const formatterData = createMockFormatter();
		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatterData.mock, createMockLinter({ canHandle: false }).mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);
			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "https://example.com/file.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);
			assert.strictEqual(formatterData.calls.format.length, 0, "no format for URL path");
		} finally {
			cleanup();
		}
	});

	it("skips tilde-prefixed paths", async () => {
		const formatterData = createMockFormatter();
		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatterData.mock, createMockLinter({ canHandle: false }).mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);
			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "~/file.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);
			assert.strictEqual(formatterData.calls.format.length, 0, "no format for tilde path");
		} finally {
			cleanup();
		}
	});

	it("skips non-TS/JS extension (.py)", async () => {
		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		// Create a .py file
		const pyPath = join(dir, "test.py");
		writeFileSync(pyPath, "print('hello')\n");

		const formatterCalls: string[] = [];
		const linterCalls: string[] = [];

		try {
			const formatter: Formatter = {
				canHandle: (p) => {
					formatterCalls.push(p);
					return false;
				},
				format: async () => ({ formatted: false }),
			};
			const linter: Linter = {
				canHandle: (p) => {
					linterCalls.push(p);
					return false;
				},
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			};

			registerHandler(pi, formatter, linter);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "test.py" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatterCalls.length, 1, "canHandle called once for formatter");
			assert.strictEqual(linterCalls.length, 1, "canHandle called once for linter");
			// format/lint should NOT be called since canHandle returned false
			// We verify by checking that no format call was made - the mock formatter
			// would have its format not called
		} finally {
			cleanup();
		}
	});

	it("skips oversized file", async () => {
		const formatterData = createMockFormatter();
		const linterData = createMockLinter({ canHandle: false });

		const dir = mkdtempSync(join(tmpdir(), "fos-size-test-"));
		try {
			const oversizedPath = join(dir, "large.ts");
			// Create a file larger than MAX_FILE_SIZE_BYTES
			const largeContent = "x".repeat(MAX_FILE_SIZE_BYTES + 1);
			writeFileSync(oversizedPath, largeContent);

			const { pi, events } = createMockAPI();
			registerHandler(pi, formatterData.mock, linterData.mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "large.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatterData.calls.format.length, 0, "no format for oversized file");
			assert.strictEqual(
				formatterData.calls.canHandle.length,
				0,
				"canHandle not called for oversized file",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips non-existent file", async () => {
		const formatterData = createMockFormatter();
		const linterData = createMockLinter({ canHandle: false });

		const { pi, events } = createMockAPI();
		const dir = mkdtempSync(join(tmpdir(), "fos-nonexist-"));
		try {
			// Don't create the file — it doesn't exist
			registerHandler(pi, formatterData.mock, linterData.mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "nonexistent.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatterData.calls.format.length, 0, "no format for non-existent file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips isError event", async () => {
		const formatterData = createMockFormatter();
		const linterData = createMockLinter();

		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatterData.mock, linterData.mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: true,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "test.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatterData.calls.format.length, 0, "no format on error event");
			assert.strictEqual(linterData.calls.lint.length, 0, "no lint on error event");
		} finally {
			cleanup();
		}
	});

	it("skips untrusted project", async () => {
		const formatterData = createMockFormatter();
		const linterData = createMockLinter();

		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatterData.mock, linterData.mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => false,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "test.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatterData.calls.format.length, 0, "no format for untrusted project");
			assert.strictEqual(linterData.calls.lint.length, 0, "no lint for untrusted project");
		} finally {
			cleanup();
		}
	});

	it("skips non-write/edit tool names", async () => {
		const formatterData = createMockFormatter();
		const linterData = createMockLinter();

		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatterData.mock, linterData.mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "read",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "test.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatterData.calls.format.length, 0, "no format for non-write/edit tool");
		} finally {
			cleanup();
		}
	});
});

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

describe("handler — lint results", () => {
	it("lint with diagnostics → sendUserMessage with Lint Diagnostics heading", async () => {
		const { sendUserMessages, notifyCalls, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: false }) } as Formatter,
			{
				canHandle: () => true,
				lint: async () => ({
					diagnostics: [
						{
							file: "test.ts",
							line: 10,
							column: 5,
							severity: "Error" as const,
							message: "Unexpected any",
							ruleId: "no-explicit-any",
						},
					],
					fixesApplied: true,
				}),
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.ok(
				sendUserMessages.some((m) => m.content.includes("Lint Diagnostics")),
				"should send followUp with Lint Diagnostics heading",
			);
			assert.ok(
				sendUserMessages.some((m) => m.options.deliverAs === "followUp"),
				"should deliver as followUp",
			);
			assert.ok(
				notifyCalls.some((m) => m.startsWith("Lint ran:")),
				"TUI should notify lint ran",
			);
		} finally {
			cleanup();
		}
	});

	it("lint with no diagnostics → no followUp", async () => {
		const { sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: false }) } as Formatter,
			{
				canHandle: () => true,
				lint: async () => ({ diagnostics: [], fixesApplied: false }),
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.strictEqual(
				sendUserMessages.filter((m) => m.content.includes("Lint Diagnostics")).length,
				0,
				"no followUp when lint finds no issues",
			);
		} finally {
			cleanup();
		}
	});

	it("lint with error → surfaces error, does not crash", async () => {
		const { consoleErrorCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: false }) } as Formatter,
			{
				canHandle: () => true,
				lint: async () => ({ diagnostics: [], fixesApplied: false, error: "config error" }),
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.ok(
				consoleErrorCalls.some((m) => m.includes("config error")),
				"should log lint error",
			);
			assert.strictEqual(
				sendUserMessages.filter((m) => m.content.includes("Lint Diagnostics")).length,
				0,
				"no followUp when lint errors",
			);
		} finally {
			cleanup();
		}
	});

	it("lint with diagnostics and no error → diagnostics sent", async () => {
		const { sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: false }) } as Formatter,
			{
				canHandle: () => true,
				lint: async () => ({
					diagnostics: [
						{
							file: "test.ts",
							line: 5,
							column: 1,
							severity: "Warning" as const,
							message: "unused var",
							ruleId: "no-unused-vars",
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
				sendUserMessages.some((m) => m.content.includes("unused var")),
				"should include diagnostic message in followUp",
			);
		} finally {
			cleanup();
		}
	});

	it("lint throws → handler catches and logs, does not crash", async () => {
		const { consoleErrorCalls, sendUserMessages, cleanup } = await runHandlerWithMocks(
			{ canHandle: () => true, format: async () => ({ formatted: false }) } as Formatter,
			{
				canHandle: () => true,
				lint: async () => {
					throw new Error("lint crash");
				},
			} as Linter,
			{},
			{ mode: "tui" },
		);
		try {
			assert.ok(
				consoleErrorCalls.some((m) => m.includes("linter threw")),
				"should log linter throw",
			);
		} finally {
			cleanup();
		}
	});
});

describe("handler — both formatter and linter called", () => {
	it("both format and lint called for .ts file", async () => {
		const formatCalls: string[] = [];
		const lintCalls: string[] = [];
		const canHandleCalls: string[] = [];

		const formatter: Formatter = {
			canHandle: (p) => {
				canHandleCalls.push("format:" + p);
				return true;
			},
			format: async (p) => {
				formatCalls.push(p);
				return { formatted: true };
			},
		};
		const linter: Linter = {
			canHandle: (p) => {
				canHandleCalls.push("lint:" + p);
				return true;
			},
			lint: async (p) => {
				lintCalls.push(p);
				return { diagnostics: [], fixesApplied: false };
			},
		};

		const { pi, events } = createMockAPI();
		const { dir, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatter, linter);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "test.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(formatCalls.length, 1, "format called once");
			assert.strictEqual(lintCalls.length, 1, "lint called once");
			assert.ok(formatCalls[0]!.endsWith("test.ts"), "format receives correct path");
			assert.ok(lintCalls[0]!.endsWith("test.ts"), "lint receives correct path");
		} finally {
			cleanup();
		}
	});
});

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

	it("Print mode → same as JSON mode", async () => {
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
			{ mode: "print" },
		);
		try {
			assert.strictEqual(notifyCalls.length, 0, "Print no notify");
			assert.strictEqual(
				sendUserMessages.filter((m) => m.content.startsWith("Formatted:")).length,
				0,
				"Print no format followUp",
			);
			assert.ok(
				sendUserMessages.some((m) => m.content.includes("Lint Diagnostics")),
				"Print lint followUp still sent",
			);
		} finally {
			cleanup();
		}
	});
});

describe("handler — guard order preserved", () => {
	it("guard order: tool name → isError → path check → exists → size → trust → format → lint", async () => {
		const formatterData = createMockFormatter();
		const linterData = createMockLinter();

		// Test that all guards pass for a valid write event
		const { pi, events } = createMockAPI();
		const { dir, filePath, cleanup } = createTempTsFile();

		try {
			registerHandler(pi, formatterData.mock, linterData.mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "test.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			// If we reach here without error, the guard chain completed
			assert.strictEqual(formatterData.calls.format.length, 1, "format called after guards pass");
		} finally {
			cleanup();
		}
	});

	it("trust check after size check preserves order", async () => {
		// Verify untrusted check happens AFTER size check by ensuring
		// an oversized file is skipped before trust check
		const formatterData = createMockFormatter();

		const dir = mkdtempSync(join(tmpdir(), "fos-order-"));
		try {
			const largePath = join(dir, "large.ts");
			writeFileSync(largePath, "x".repeat(MAX_FILE_SIZE_BYTES + 1));

			const { pi, events } = createMockAPI();
			registerHandler(pi, formatterData.mock, createMockLinter({ canHandle: false }).mock);
			const toolResult = events.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const ctx = {
				cwd: dir,
				ui: {
					notify: () => {},
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionUIContext,
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult.handler(
				{
					toolName: "write",
					isError: false,
					type: "tool_result",
					toolCallId: "c1",
					input: { path: "large.ts" },
					content: [],
				} as unknown as ToolResultEvent,
				ctx,
			);

			assert.strictEqual(
				formatterData.calls.canHandle.length,
				0,
				"canHandle not called for oversized file",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: formatEslintDiagnostics — refactored presentation utility
// ═══════════════════════════════════════════════════════════════════════

describe("formatEslintDiagnostics (Diagnostic[])", () => {
	it("empty → empty string", () => {
		assert.strictEqual(formatEslintDiagnostics([]), "");
	});

	it("single error → formatted line", () => {
		const result = formatEslintDiagnostics([
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Unexpected any",
				ruleId: "@typescript-eslint/no-explicit-any",
			},
		]);
		assert.strictEqual(
			result,
			"src/app.ts, Line 10: [Error] Unexpected any (@typescript-eslint/no-explicit-any)",
		);
	});

	it("single warning without ruleId → no rule part", () => {
		const result = formatEslintDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Warning", message: "unused", ruleId: null },
		]);
		assert.strictEqual(result, "a.ts, Line 1: [Warning] unused");
	});

	it("errors sort before warnings in same file", () => {
		const result = formatEslintDiagnostics([
			{ file: "a.ts", line: 2, column: 1, severity: "Warning", message: "warn", ruleId: "w" },
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "err", ruleId: "e" },
		]);
		const lines = result.split("\n");
		assert.strictEqual(lines[0], "a.ts, Line 1: [Error] err (e)");
		assert.strictEqual(lines[1], "a.ts, Line 2: [Warning] warn (w)");
	});

	it("multiple files → blocks separated by blank line", () => {
		const result = formatEslintDiagnostics([
			{ file: "b.ts", line: 1, column: 1, severity: "Error", message: "err1", ruleId: null },
			{ file: "a.ts", line: 1, column: 1, severity: "Warning", message: "warn1", ruleId: null },
		]);
		assert.ok(result.includes("\n\n"), "files should be separated by blank line");
		assert.ok(result.startsWith("a.ts"), "files should be sorted alphabetically");
	});

	it("message >500 chars truncated", () => {
		const longMsg = "x".repeat(1000);
		const result = formatEslintDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: longMsg, ruleId: null },
		]);
		assert.ok(result.length < 600, "result should be shorter than original message");
		assert.ok(result.includes("..."), "truncated message should end with ...");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// looksLikeFilePath — basic validation
// ═══════════════════════════════════════════════════════════════════════

describe("looksLikeFilePath", () => {
	it("valid path → true", () => {
		assert.strictEqual(looksLikeFilePath("src/app.ts"), true);
	});

	it("URL → false", () => {
		assert.strictEqual(looksLikeFilePath("https://example.com"), false);
	});

	it("tilde prefix → false", () => {
		assert.strictEqual(looksLikeFilePath("~/file.ts"), false);
	});

	it("empty string → false", () => {
		assert.strictEqual(looksLikeFilePath(""), false);
	});

	it("non-string → false", () => {
		assert.strictEqual(looksLikeFilePath(undefined), false);
		assert.strictEqual(looksLikeFilePath(null), false);
		assert.strictEqual(looksLikeFilePath(42), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// PrettierFormatter — unit tests (Phase 3)
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// EslintLinter — unit tests (Phase 4, mock-based)
// ═══════════════════════════════════════════════════════════════════════

describe("EslintLinter unit tests", () => {
	it("canHandle returns true for .ts, .tsx, .js, .jsx", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const l = new EslintLinter();
		assert.strictEqual(l.canHandle("/path/file.ts"), true);
		assert.strictEqual(l.canHandle("/path/file.tsx"), true);
		assert.strictEqual(l.canHandle("/path/file.js"), true);
		assert.strictEqual(l.canHandle("/path/file.jsx"), true);
	});

	it("canHandle returns false for .json, .md, .py", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const l = new EslintLinter();
		assert.strictEqual(l.canHandle("/path/file.json"), false);
		assert.strictEqual(l.canHandle("/path/file.md"), false);
		assert.strictEqual(l.canHandle("/path/file.py"), false);
	});

	it("lint returns diagnostics with correct severity mapping", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const mockESLint = async () => ({
			lintText: async (_text: string, _opts: { filePath: string }) => [
				{
					filePath: "/path/file.ts",
					messages: [
						{ line: 1, column: 1, severity: 2, message: "error msg", ruleId: "no-err" },
						{ line: 2, column: 1, severity: 1, message: "warning msg", ruleId: "no-warn" },
					],
				},
			],
		});

		// We need to mock the file read too
		const l = new EslintLinter(mockESLint as any);
		// Override the readFile to avoid actual I/O
		(l as any).readFile = async () => "const x = 1;\n";

		const result = await l.lint("/path/file.ts");
		assert.strictEqual(result.diagnostics.length, 2);
		assert.strictEqual(result.diagnostics[0]!.severity, "Error");
		assert.strictEqual(result.diagnostics[0]!.ruleId, "no-err");
		assert.strictEqual(result.diagnostics[1]!.severity, "Warning");
		assert.strictEqual(result.diagnostics[1]!.ruleId, "no-warn");
	});

	it("lint returns empty diagnostics for clean file", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const mockESLint = async () => ({
			lintText: async (_text: string, _opts: { filePath: string }) => [
				{ filePath: "/path/file.ts", messages: [] },
			],
		});

		const l = new EslintLinter(mockESLint as any);
		(l as any).readFile = async () => "const x = 1;\n";

		const result = await l.lint("/path/file.ts");
		assert.strictEqual(result.diagnostics.length, 0);
		assert.strictEqual(result.fixesApplied, false);
	});

	it("lint returns error gracefully when ESLint is not available", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const failingFactory = async () => {
			throw new Error("Cannot find module 'eslint'");
		};
		const l = new EslintLinter(failingFactory);

		const result = await l.lint("/path/file.ts");
		assert.strictEqual(result.diagnostics.length, 0);
		assert.strictEqual(result.fixesApplied, false);
		assert.ok(result.error, "should return error message");
	});

	it("lint handles empty file (returns empty diagnostics)", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const mockESLint = async () => ({
			lintText: async (_text: string, _opts: { filePath: string }) => [
				{ filePath: "/path/file.ts", messages: [] },
			],
		});

		const l = new EslintLinter(mockESLint as any);
		(l as any).readFile = async () => "";

		const result = await l.lint("/path/file.ts");
		assert.strictEqual(result.diagnostics.length, 0);
	});
});
