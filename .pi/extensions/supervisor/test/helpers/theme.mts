/**
 * Shared theme double for renderer tests.
 *
 * The renderer stack styles through pi's `Theme` port: `fg()` for a single
 * foreground token and `style()` for combined attributes (fg/bg/bold/…).
 * This factory records both calls and returns text unchanged (no ANSI), which
 * is what renderer unit tests rely on for content assertions. Pass `wrap` /
 * `styleWrap` to substitute the returned text (e.g. `[color]text[/color]`).
 *
 * Run a file that uses it with:
 *   node --experimental-strip-types --test <file>
 */

export interface FgCall {
	color: string;
	text: string;
}

export interface StyleCall {
	text: string;
	options: any;
}

export interface TestTheme {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	underline: (text: string) => string;
	strikethrough: (text: string) => string;
	style: (text: string, options: any) => string;
	appearance?: "dark" | "light";
}

export interface TestThemeRecorder {
	theme: TestTheme;
	fgCalls: FgCall[];
	styleCalls: StyleCall[];
}

/**
 * Build a recording theme double. `wrap` overrides `fg()` output, `styleWrap`
 * overrides `style()` output; both default to identity (no ANSI).
 */
export function makeTestTheme(options?: {
	wrap?: (color: string, text: string) => string;
	styleWrap?: (text: string, styleOptions: any) => string;
	appearance?: "dark" | "light";
}): TestThemeRecorder {
	const fgCalls: FgCall[] = [];
	const styleCalls: StyleCall[] = [];
	const wrap = options?.wrap ?? ((_color: string, text: string) => text);
	const styleWrap = options?.styleWrap ?? ((text: string) => text);

	const theme: TestTheme = {
		fg: (color: string, text: string) => {
			fgCalls.push({ color, text });
			return wrap(color, text);
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		style: (text: string, styleOptions: any) => {
			styleCalls.push({ text, options: styleOptions });
			return styleWrap(text, styleOptions);
		},
	};
	if (options?.appearance) theme.appearance = options.appearance;

	return { theme, fgCalls, styleCalls };
}
