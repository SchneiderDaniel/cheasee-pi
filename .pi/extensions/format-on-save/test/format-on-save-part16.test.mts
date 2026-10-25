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

describe("EslintLinter — flat-config fallback (useEslintrc removed)", () => {
	it("createFallbackESLint constructs without throwing on the installed eslint (dead-constructor regression)", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const l = new EslintLinter();
		// REAL eslint via the private method — must not mock createFallbackESLint
		const instance = await (l as any).createFallbackESLint();
		assert.ok(instance, "fallback instance should construct on flat config");
		assert.ok(!String((l as any).buildFallbackOptions("10.8.0", [])).includes("useEslintrc"));
	});
	it("lint() falls back on a broken config for .js — real config SyntaxError, never Invalid Options", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const { dir, jsFile, cleanup } = createBrokenConfigFixture();
		try {
			const l = new EslintLinter(); // default factory — real eslint
			const result = (await withCwd(dir, () => l.lint(jsFile))) as Awaited<
				ReturnType<typeof l.lint>
			>;
			assert.ok(result.error, "should surface the original config error");
			assert.ok(
				result.error!.includes("Unexpected end of input"),
				"error should carry the original SyntaxError text",
			);
			assert.ok(
				!result.error!.includes("Invalid Options") && !result.error!.includes("useEslintrc"),
				"must never surface the removed-option constructor error",
			);
		} finally {
			cleanup();
		}
	});
	it("lint() completes on a broken config for .ts — fallback ran, config error preserved", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const { dir, tsFile, cleanup } = createBrokenConfigFixture();
		try {
			const l = new EslintLinter();
			const result = (await withCwd(dir, () => l.lint(tsFile))) as Awaited<
				ReturnType<typeof l.lint>
			>;
			assert.ok(result.error, "config error preserved");
			assert.ok(result.error!.includes("Unexpected end of input"));
			assert.ok(
				!result.error!.includes("Invalid Options") && !result.error!.includes("useEslintrc"),
				"must never surface the removed-option constructor error",
			);
			// espree cannot parse TS — parse failure may surface as mapped
			// diagnostics; the key assertion is the fallback ran (no throw)
			assert.ok(Array.isArray(result.diagnostics));
		} finally {
			cleanup();
		}
	});
	it("fallback constructor options: flat config on 9+, legacy useEslintrc on v8", async () => {
		// eslint 8 (EOL 2024-10-05) is not installable here; the exact
		// option objects for both branches are asserted via the pure
		// buildFallbackOptions gate below, and the flat branch is proven
		// against the real installed eslint by the constructor regression
		// test (passing useEslintrc on v9+ would throw "Invalid Options").
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const l = new EslintLinter();
		const cfg: unknown[] = [{ files: ["**/*.js"] }];

		// Flat branch (major >= 9): skip config lookup + non-empty config
		const flat = (l as any).buildFallbackOptions("10.8.0", cfg) as {
			overrideConfigFile?: boolean;
			overrideConfig?: unknown[];
			useEslintrc?: unknown;
		};
		assert.ok(!("useEslintrc" in flat), "must not pass the removed useEslintrc option");
		assert.strictEqual(flat.overrideConfigFile, true, "must skip config-file lookup");
		assert.ok(
			Array.isArray(flat.overrideConfig) && flat.overrideConfig.length > 0,
			"must carry a non-empty minimal config",
		);

		// Legacy branch (major < 9): eslintrc-era option
		assert.deepStrictEqual((l as any).buildFallbackOptions("8.57.0", cfg), {
			useEslintrc: false,
		});
	});
	it("fallback options gate on the ESLint major: v8 legacy, v9/v10 flat", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const l = new EslintLinter();
		const cfg: unknown[] = [{ files: ["**/*.js"] }];
		assert.deepStrictEqual((l as any).buildFallbackOptions("8.57.0", cfg), {
			useEslintrc: false,
		});
		assert.deepStrictEqual((l as any).buildFallbackOptions("9.0.0", cfg), {
			overrideConfigFile: true,
			overrideConfig: cfg,
		});
		assert.deepStrictEqual((l as any).buildFallbackOptions("10.8.0", cfg), {
			overrideConfigFile: true,
			overrideConfig: cfg,
		});
	});
	it("isConfigError returns true for SyntaxError (syntax-broken config file)", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const l = new EslintLinter();
		assert.strictEqual(
			(l as any).isConfigError({ name: "SyntaxError", message: "Unexpected end of input" }),
			true,
		);
	});
	it("isConfigError still classifies ConfigError/legacy keywords and rejects non-config errors", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const l = new EslintLinter();
		assert.strictEqual((l as any).isConfigError({ name: "ConfigError", message: "bad" }), true);
		assert.strictEqual(
			(l as any).isConfigError({ name: "Error", message: "Failed to load config" }),
			true,
		);
		assert.strictEqual(
			(l as any).isConfigError({
				name: "TypeError",
				message: "Cannot read properties of undefined",
			}),
			false,
		);
	});
	it("buildFallbackConfig returns a non-empty files-matching config covering all supported extensions", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");
		const l = new EslintLinter();
		const config = (await (l as any).buildFallbackConfig()) as Array<{
			files?: string[];
			languageOptions?: { ecmaVersion?: string; sourceType?: string };
		}>;
		assert.ok(Array.isArray(config) && config.length > 0, "config must not be []");
		const files = config[0]!.files;
		assert.ok(files && files.length > 0, "first object must carry a files glob");
		for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
			assert.ok(files[0]!.includes(ext.slice(1)), `files glob should cover ${ext}: ${files[0]}`);
		}
		assert.deepStrictEqual(config[0]!.languageOptions, {
			ecmaVersion: "latest",
			sourceType: "module",
		});
	});
	it("buildFallbackConfig wires the TS parser when resolvable; stays non-empty without it", async () => {
		const { EslintLinter } = await import("../eslint-adapter.mts");

		// Unresolvable branch — typescript-eslint is not installed here
		const l = new EslintLinter();
		const noParser = (await (l as any).buildFallbackConfig()) as Array<{
			files?: string[];
			languageOptions?: { parser?: unknown };
		}>;
		assert.strictEqual(noParser.length, 1, "no parser entry without typescript-eslint");
		assert.ok(noParser[0]!.files && noParser[0]!.files!.length > 0, "still a non-empty config");

		// Resolvable branch — override the resolver to simulate installation
		const l2 = new EslintLinter();
		(l2 as any).resolveTsParser = async () => ({ meta: { name: "typescript-eslint/parser" } });
		const withParser = (await (l2 as any).buildFallbackConfig()) as Array<{
			files?: string[];
			languageOptions?: { parser?: unknown };
		}>;
		assert.strictEqual(withParser.length, 2, "parser entry appended");
		const tsEntry = withParser[1]!;
		assert.ok(tsEntry.files![0]!.includes("ts"), "parser entry targets ts/tsx");
		assert.ok(tsEntry.languageOptions?.parser, "parser wired into the config");
	});
});
