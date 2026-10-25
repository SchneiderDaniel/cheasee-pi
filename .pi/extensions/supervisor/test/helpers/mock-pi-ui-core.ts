/**
 * mock-pi-ui-core.ts — captured-output / dialog / working-indicator UI stubs.
 *
 * Split out of mock-pi.ts (issue #2036). Returns the `ExtensionUIContext`
 * subset that records into `captured`; `mock-pi-ui.ts` composes it with the
 * editor and theme-context stubs.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { CapturedOutput } from "./capture-core.ts";

export function uiCoreStubs(captured: CapturedOutput): Partial<ExtensionUIContext> {
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
	};
}
