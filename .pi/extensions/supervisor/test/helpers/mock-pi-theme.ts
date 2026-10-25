/**
 * mock-pi-theme.ts — minimal `Theme` mock.
 *
 * Split out of mock-pi.ts (issue #2036) so no mock module carries a VBA-god
 * declaration count. `mock-pi.ts` re-exports the public factory.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * Create a minimal mock Theme object.
 *
 * - `fg()` is an identity pass-through (returns text unchanged)
 * - `bg()` is an identity pass-through
 * - Other styling methods are identity pass-throughs
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
