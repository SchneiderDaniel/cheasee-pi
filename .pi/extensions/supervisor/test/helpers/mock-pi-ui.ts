/**
 * mock-pi-ui.ts — mock `ExtensionUIContext` factory.
 *
 * Split out of mock-pi.ts (issue #2036). Composes the captured-output,
 * editor and theme-context subsets; `mock-pi.ts` re-exports it.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { CapturedOutput } from "./capture-core.ts";
import { createMockTheme } from "./mock-pi-theme.ts";
import { uiCoreStubs } from "./mock-pi-ui-core.ts";
import { uiEditorStubs } from "./mock-pi-ui-editor.ts";
import { uiThemeCtxStubs } from "./mock-pi-ui-theme-ctx.ts";

export function createMockUI(captured: CapturedOutput): ExtensionUIContext {
	return {
		...uiCoreStubs(captured),
		...uiEditorStubs(),
		...uiThemeCtxStubs(),
		theme: createMockTheme(),
	} as unknown as ExtensionUIContext;
}
