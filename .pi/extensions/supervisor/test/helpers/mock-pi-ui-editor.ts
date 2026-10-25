/**
 * mock-pi-ui-editor.ts — header/footer/title, custom-component and editor
 * UI stubs.
 *
 * Split out of mock-pi.ts (issue #2036). `mock-pi-ui.ts` composes it with the
 * captured-output and theme-context subsets.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export function uiEditorStubs(): Partial<ExtensionUIContext> {
	return {
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
	};
}
