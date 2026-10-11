/**
 * mock-pi.ts — ExtensionAPI / UI-context mock factories.
 *
 * Split out of capture.ts (issue #2001). Owns the `createMockPi` factory and
 * its UI/theme/session/model stubs; the captured-output container lives in
 * capture-core.ts.
 */

import type {
	ExtensionAPI,
	ExtensionUIContext,
	EventBus,
	ExecOptions,
	ExecResult,
	Theme,
	ThemeColor,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { CapturedOutput, makeExecResult, lookupExecFixture } from "./capture-core.ts";

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
export function createMockTheme(): Theme {
	function identityPassThrough(text: string): string {
		return text;
	}
	return {
		name: "mock",
		sourcePath: undefined,
		fg: (_color: ThemeColor, text: string) => text,
		bg: (_color: any, text: string) => text,
		style: (text: string, _options: any) => text,
		bold: identityPassThrough,
		italic: identityPassThrough,
		underline: identityPassThrough,
		inverse: identityPassThrough,
		strikethrough: identityPassThrough,
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

export function createMockUI(captured: CapturedOutput): ExtensionUIContext {
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
export function createMockSessionManager() {
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
		buildContextEntries: () => [],
		buildSessionProjection: () => ({
			entries: [],
			messages: [],
			thinkingLevel: "off",
			model: null,
		}),
		getHeader: () => null,
		getEntries: () => [],
		getTree: () => [],
		getSessionName: () => undefined,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Mock ModelRegistry
// ═══════════════════════════════════════════════════════════════════════

export function createMockModelRegistry(): ModelRegistry {
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
		on(_event: any, _handler: any) {
			return () => {};
		},

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
		registerMarkdownTransformer(_transformer: any) {},
		registerEntryRenderer(_customType: string, _renderer: any) {},
		registerToolRenderer(_resolver: any) {},
		getSettings(): any {
			return {};
		},
		registerMcpServer(_name: string, _config: any) {},
		unregisterMcpServer(_name: string) {},
		getMcpServers(): any[] {
			return [];
		},
		registerVirtualModel(_model: any) {},
		unregisterVirtualModel(_provider: string, _id: string) {},

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
		registerProvider(_providerOrName: any, _config?: any) {},
		unregisterProvider(_name: string) {},

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
