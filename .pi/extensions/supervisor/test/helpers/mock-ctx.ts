/**
 * mock-ctx.ts — ExtensionCommandContext mock factory.
 *
 * Split out of capture.ts (issue #2001). Builds the full command-context
 * stub on top of the UI/session/model mocks in mock-pi.ts.
 */

import type {
	ExtensionCommandContext,
	BuildSystemPromptOptions,
	CompactOptions,
	ContextUsage,
} from "@earendil-works/pi-coding-agent";
import { CapturedOutput } from "./capture-core.ts";
import { createMockUI, createMockSessionManager, createMockModelRegistry } from "./mock-pi.ts";

/**
 * Default BuildSystemPromptOptions for mock contexts.
 */
export function defaultSystemPromptOptions(cwd: string): BuildSystemPromptOptions {
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
		scopedModels: [],
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
