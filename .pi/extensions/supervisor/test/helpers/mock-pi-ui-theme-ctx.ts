/**
 * mock-pi-ui-theme-ctx.ts — theme lookup and tools-expansion UI stubs.
 *
 * Split out of mock-pi.ts (issue #2036). `theme` itself is injected by
 * `mock-pi-ui.ts`, which owns the `createMockTheme` dependency.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export function uiThemeCtxStubs(): Partial<ExtensionUIContext> {
	return {
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
