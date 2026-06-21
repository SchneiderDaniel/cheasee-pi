/**
 * capture.ts — Shared capture harness for supervisor output tests.
 *
 * Provides typed mock factories for ExtensionAPI and ExtensionCommandContext
 * that capture all terminal/GitHub output calls into a shared CapturedOutput instance.
 * Eliminates per-test inline mock drift.
 *
 * Run with: node --experimental-strip-types --test
 *
 * Usage:
 * ```ts
 * import { describe, it, beforeEach } from "node:test";
 * import { CapturedOutput, createMockPi, createMockCtx } from "../helpers/capture.ts";
 *
 * let captured: CapturedOutput;
 * let pi: ExtensionAPI;
 * let ctx: ExtensionCommandContext;
 *
 * beforeEach(() => {
 *   captured = new CapturedOutput();
 *   pi = createMockPi(captured);
 *   ctx = createMockCtx(captured);
 * });
 * ```
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
	ExecResult,
	ExecOptions,
	EventBus,
	BuildSystemPromptOptions,
	CompactOptions,
	ContextUsage,
	Theme,
	ThemeColor,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

// ═══════════════════════════════════════════════════════════════════════
// Captured Output Types
// ═══════════════════════════════════════════════════════════════════════

/** A single call to pi.sendMessage() with its options. */
export interface CapturedMessage {
	customType: string;
	content: string | Array<{ type: string; text?: string }>;
	display?: boolean;
	details?: unknown;
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** A single call to ctx.ui.setWidget(). */
export interface CapturedWidget {
	id: string;
	lines?: string[];
}

/** A single call to ctx.ui.setStatus(). */
export interface CapturedStatus {
	key: string;
	text?: string;
}

/** A single call to ctx.ui.notify(). */
export interface CapturedNotification {
	msg: string;
	type?: "info" | "warning" | "error";
}

/** A single call to pi.exec(). */
export interface CapturedExecCall {
	cmd: string;
	args: string[];
}

/**
 * Container for all captured terminal and GitHub output.
 *
 * Create one instance per test in beforeEach() to prevent
 * cross-test ordering dependencies from shared mutable arrays.
 */
export class CapturedOutput {
	messages: CapturedMessage[] = [];
	widgets: CapturedWidget[] = [];
	statuses: CapturedStatus[] = [];
	notifications: CapturedNotification[] = [];
	execCalls: CapturedExecCall[] = [];
}

// ═══════════════════════════════════════════════════════════════════════
// ExecResult Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Construct a valid pi-coding-agent ExecResult shape.
 *
 * Unspecified fields default to:
 * - stdout: ""
 * - stderr: ""
 * - code: 0
 * - killed: false
 *
 * Use this in test fixtures to ensure ExecResult matches
 * what production code actually receives.
 */
export function makeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
	return {
		stdout: "",
		stderr: "",
		code: 0,
		killed: false,
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Fixture Registry
// ═══════════════════════════════════════════════════════════════════════
//
// Module-level registry so createMockPi's exec() can look up pre-registered
// responses. Reset in beforeEach() via resetMocks().

const fixtureRegistry = new Map<string, ExecResult>();

/**
 * Register a single exec response for a specific (cmd, args) pair.
 *
 * The lookup key is `${cmd} ${args.join(" ")}`.
 * Use `setMockResponses()` to register multiple at once.
 */
export function mockExecResponse(cmd: string, args: string[], result: ExecResult): void {
	fixtureRegistry.set(keyFor(cmd, args), result);
}

/**
 * Register multiple exec responses at once.
 *
 * Keys are `${cmd} ${args.join(" ")}` strings.
 * For commands with varying arguments, use `"*"` as the args part to match any args.
 *
 * @example
 * ```ts
 * setMockResponses({
 *   "gh issue view 123": makeExecResult({ stdout: "issue body" }),
 *   "gh issue view *":   makeExecResult({ stdout: "fallback" }),
 * });
 * ```
 */
export function setMockResponses(map: Record<string, ExecResult>): void {
	for (const [key, result] of Object.entries(map)) {
		fixtureRegistry.set(key, result);
	}
}

/**
 * Clear all registered exec fixtures.
 *
 * Call in beforeEach() to prevent cross-test leakage of exec responses.
 */
export function resetMocks(): void {
	fixtureRegistry.clear();
}

/** Build the lookup key for a (cmd, args) pair. */
function keyFor(cmd: string, args: string[]): string {
	return `${cmd} ${args.join(" ")}`;
}

/**
 * Look up a registered fixture for (cmd, args).
 *
 * Resolution order:
 * 1. Exact match on `${cmd} ${args.join(" ")}`
 * 2. Wildcard match: iterate registered keys, treat `*` as match-any
 * 3. Return undefined (caller gets default error result)
 */
function lookupExecFixture(cmd: string, args: string[]): ExecResult | undefined {
	const needle = keyFor(cmd, args);

	// 1. Exact match
	const exact = fixtureRegistry.get(needle);
	if (exact !== undefined) return exact;

	// 2. Wildcard — iterate keys and check glob-style match
	for (const [key, result] of fixtureRegistry) {
		if (globMatch(needle, key)) {
			return result;
		}
	}

	// 3. No match
	return undefined;
}

/**
 * Simple glob match: `*` matches any sequence of characters (including empty).
 * No other glob syntax is supported.
 */
function globMatch(input: string, pattern: string): boolean {
	if (!pattern.includes("*")) {
		return input === pattern;
	}
	const parts = pattern.split("*");
	let pos = 0;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === "") continue; // leading/trailing/multiple wildcards
		const idx = input.indexOf(part, pos);
		if (idx === -1) return false;
		pos = idx + part.length;
	}
	return true;
}

// ═══════════════════════════════════════════════════════════════════════
// Mock Theme
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a minimal mock Theme object.
 *
 * - `fg()` is an identity pass-through (returns text unchanged)
 * - `bg()` is an identity pass-through
 * - Other styling methods are identity pass-throughs
 *
 * Tests that need color-tagged output verification should opt-in to
 * color capture by replacing `ctx.ui.theme` with a custom mock.
 */
function createMockTheme(): Theme {
	function identity(text: string): string {
		return text;
	}
	return {
		name: "mock",
		sourcePath: undefined,
		fg: (_color: ThemeColor, text: string) => text,
		bg: (_color: any, text: string) => text,
		bold: identity,
		italic: identity,
		underline: identity,
		inverse: identity,
		strikethrough: identity,
		getFgAnsi: () => "",
		getBgAnsi: () => "",
		getColorMode: () => "truecolor" as const,
		getThinkingBorderColor: () => (str: string) => str,
		getBashModeBorderColor: () => (str: string) => str,
	} as unknown as Theme;
}

// ═══════════════════════════════════════════════════════════════════════
// Mock ExtensionUIContext
// ═══════════════════════════════════════════════════════════════════════

function createMockUI(captured: CapturedOutput): ExtensionUIContext {
	return {
		// ── Captured output ──
		notify(msg: string, type?: "info" | "warning" | "error") {
			captured.notifications.push({ msg, type });
		},
		setStatus(key: string, text?: string) {
			captured.statuses.push({ key, text });
		},
		setWidget(key: string, content?: any, _options?: any) {
			captured.widgets.push({
				id: key,
				lines: Array.isArray(content) ? content : undefined,
			});
		},

		// ── Dialogs ──
		async select(_title: string, _options: string[], _opts?: any): Promise<string | undefined> {
			return undefined;
		},
		async confirm(_title: string, _message: string, _opts?: any): Promise<boolean> {
			return true;
		},
		async input(_title: string, _placeholder?: string, _opts?: any): Promise<string | undefined> {
			return undefined;
		},

		// ── Terminal input ──
		onTerminalInput(_handler: any): () => void {
			return () => {};
		},

		// ── Working indicator ──
		setWorkingMessage(_message?: string) {},
		setWorkingVisible(_visible: boolean) {},
		setWorkingIndicator(_options?: any) {},
		setHiddenThinkingLabel(_label?: string) {},

		// ── Header / Footer / Title ──
		setFooter(_factory?: any) {},
		setHeader(_factory?: any) {},
		setTitle(_title: string) {},

		// ── Custom components ──
		async custom<T>(_factory: any, _options?: any): Promise<T> {
			throw new Error("custom UI is not implemented in the mock Capture harness");
		},

		// ── Editor ──
		pasteToEditor(_text: string) {},
		setEditorText(_text: string) {},
		getEditorText(): string {
			return "";
		},
		async editor(_title: string, _prefill?: string): Promise<string | undefined> {
			return undefined;
		},
		addAutocompleteProvider(_factory: any) {},
		setEditorComponent(_factory?: any) {},
		getEditorComponent(): any {
			return undefined;
		},

		// ── Theme ──
		theme: createMockTheme(),
		getAllThemes() {
			return [];
		},
		getTheme(_name: string): any {
			return undefined;
		},
		setTheme(_theme: any) {
			return { success: false, error: "setTheme is not implemented in the mock Capture harness" };
		},

		// ── Tools expansion ──
		getToolsExpanded(): boolean {
			return false;
		},
		setToolsExpanded(_expanded: boolean) {},
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Mock ReadonlySessionManager
// ═══════════════════════════════════════════════════════════════════════

/** Minimal stub satisfying ReadonlySessionManager (structural Pick<> type). */
function createMockSessionManager() {
	return {
		getCwd: () => "/repo",
		getSessionDir: () => "/repo/.pi/sessions",
		getSessionId: () => "mock-session-id",
		getSessionFile: () => "/repo/.pi/sessions/mock.json",
		getLeafId: () => null,
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getBranch: () => [],
		getHeader: () => null,
		getEntries: () => [],
		getTree: () => [],
		getSessionName: () => undefined,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Mock ModelRegistry
// ═══════════════════════════════════════════════════════════════════════

function createMockModelRegistry(): ModelRegistry {
	// ModelRegistry is a class with many methods. Tests rarely interact
	// with it directly, so provide a minimal proxy.
	return {
		getModel: () => undefined,
		getAllModels: () => [],
		getProviderModels: () => [],
	} as unknown as ModelRegistry;
}

// ═══════════════════════════════════════════════════════════════════════
// createMockPi — Full ExtensionAPI
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a complete ExtensionAPI mock backed by `captured`.
 *
 * Captured methods:
 * - `sendMessage()` pushes to `captured.messages` (including options)
 * - `exec()` pushes to `captured.execCalls`, returns registered fixture or default error
 * - `events.emit()` is a safe no-op
 *
 * All other ExtensionAPI methods are provided with no-op stubs so the
 * returned value satisfies the `ExtensionAPI` type without `as unknown as` casts.
 *
 * @example
 * ```ts
 * const captured = new CapturedOutput();
 * const pi = createMockPi(captured);
 * pi.sendMessage({ customType: "test", content: "hello", display: true });
 * assert.equal(captured.messages.length, 1);
 * ```
 */
export function createMockPi(captured: CapturedOutput): ExtensionAPI {
	const events: EventBus = {
		emit(_channel: string, _data: unknown) {},
		on(_channel: string, _handler: (data: unknown) => void): () => void {
			return () => {};
		},
	};

	const pi: ExtensionAPI = {
		// ══ Event handlers (all events) ══
		on(_event: any, _handler: any) {},

		// ══ Commands ══
		registerCommand(_name: string, _options: any) {},
		registerShortcut(_shortcut: any, _options: any) {},
		registerFlag(_name: string, _options: any) {},
		getFlag(_name: string): boolean | string | undefined {
			return undefined;
		},

		// ══ Tools ══
		registerTool(_tool: any) {},
		registerMessageRenderer(_customType: string, _renderer: any) {},
		getActiveTools(): string[] {
			return [];
		},
		getAllTools(): any[] {
			return [];
		},
		setActiveTools(_toolNames: string[]) {},

		// ══ Session messaging ══
		sendMessage<T = unknown>(
			message: { customType: string; content: any; display?: boolean; details?: T },
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		) {
			captured.messages.push({
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				triggerTurn: options?.triggerTurn,
				deliverAs: options?.deliverAs,
			});
		},
		sendUserMessage(_content: any, _options?: any) {},
		appendEntry<T = unknown>(_customType: string, _data?: T) {},
		setSessionName(_name: string) {},
		getSessionName(): string | undefined {
			return undefined;
		},
		setLabel(_entryId: string, _label?: string) {},

		// ══ Commands info ══
		getCommands(): any[] {
			return [];
		},

		// ══ Model ══
		async setModel(_model: Model<any>): Promise<boolean> {
			return true;
		},
		getThinkingLevel(): any {
			return "off";
		},
		setThinkingLevel(_level: any) {},

		// ══ Providers ══
		registerProvider(_name: string, _config: any) {},
		unregisterProvider(_name: string) {},

		// ══ executeTool (augmented via declare module in supervisor/index.ts) ══
		executeTool(
			_toolName: string,
			_params: Record<string, unknown>,
			_options?: { signal?: AbortSignal; onUpdate?: (result: any) => void },
		): Promise<any> {
			return Promise.resolve({
				content: [{ type: "text" as const, text: "mock executeTool result" }],
				details: {
					agentName: "mock-agent",
					success: true,
					statusLabel: "SUCCESS",
					summaryLine: "Mock agent completed successfully",
					model: "mock-model",
					inputTokens: 0,
					outputTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turnCount: 1,
					durationMs: 0,
				},
			});
		},

		// ══ Command execution ══
		async exec(command: string, args: string[], _options?: ExecOptions): Promise<ExecResult> {
			captured.execCalls.push({ cmd: command, args });
			const fixture = lookupExecFixture(command, args);
			return fixture ?? makeExecResult({ code: 1 });
		},

		// ══ Event bus ══
		events,
	};

	return pi;
}

// ═══════════════════════════════════════════════════════════════════════
// createMockCtx — Full ExtensionCommandContext
// ═══════════════════════════════════════════════════════════════════════

/**
 * Default BuildSystemPromptOptions for mock contexts.
 */
function defaultSystemPromptOptions(cwd: string): BuildSystemPromptOptions {
	return {
		cwd,
		customPrompt: undefined,
		selectedTools: undefined,
		toolSnippets: undefined,
		promptGuidelines: undefined,
		appendSystemPrompt: undefined,
		contextFiles: undefined,
		skills: undefined,
	};
}

/**
 * Create a complete ExtensionCommandContext mock backed by `captured`.
 *
 * Captured methods:
 * - `ui.setWidget()` pushes to `captured.widgets`
 * - `ui.setStatus()` pushes to `captured.statuses`
 * - `ui.notify()` pushes to `captured.notifications`
 *
 * All other ExtensionCommandContext methods are provided with sensible
 * defaults so the returned value satisfies the type without type assertions.
 *
 * @param captured The CapturedOutput instance to record into.
 * @param options Optional overrides:
 *   - `cwd`: working directory (default "/repo")
 *   - `hasUI`: whether dialog-capable UI is available (default false)
 *   - `signal`: AbortSignal for the context (default undefined)
 *
 * @example
 * ```ts
 * const captured = new CapturedOutput();
 * const ctx = createMockCtx(captured, { hasUI: true });
 * ctx.ui.notify("hello", "info");
 * assert.equal(captured.notifications[0].msg, "hello");
 * ```
 */
export function createMockCtx(
	captured: CapturedOutput,
	options?: {
		cwd?: string;
		hasUI?: boolean;
		signal?: AbortSignal;
	},
): ExtensionCommandContext {
	const opts = {
		cwd: "/repo",
		hasUI: false,
		signal: undefined as AbortSignal | undefined,
		...options,
	};

	const ctx: ExtensionCommandContext = {
		// ══ ExtensionContext ══
		ui: createMockUI(captured),
		mode: "print",
		hasUI: opts.hasUI,
		cwd: opts.cwd,
		sessionManager: createMockSessionManager(),
		modelRegistry: createMockModelRegistry(),
		model: undefined,
		isIdle(): boolean {
			return true;
		},
		isProjectTrusted(): boolean {
			return true;
		},
		signal: opts.signal,
		abort() {},
		hasPendingMessages(): boolean {
			return false;
		},
		shutdown() {},
		getContextUsage(): ContextUsage | undefined {
			return undefined;
		},
		compact(_options?: CompactOptions) {},
		getSystemPrompt(): string {
			return "";
		},

		// ══ ExtensionCommandContext ══
		getSystemPromptOptions(): BuildSystemPromptOptions {
			return defaultSystemPromptOptions(opts.cwd);
		},
		async waitForIdle(): Promise<void> {},
		async newSession(_options?: any): Promise<{ cancelled: boolean }> {
			return { cancelled: false };
		},
		async fork(_entryId: string, _options?: any): Promise<{ cancelled: boolean }> {
			return { cancelled: false };
		},
		async navigateTree(_targetId: string, _options?: any): Promise<{ cancelled: boolean }> {
			return { cancelled: false };
		},
		async switchSession(_sessionPath: string, _options?: any): Promise<{ cancelled: boolean }> {
			return { cancelled: false };
		},
		async reload(): Promise<void> {},
	};

	return ctx;
}

// ═══════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════

export type { ExecResult };
