// ─── Sentinel Theme mock for the config-ui dialog suite (VBA split #2036) ───
// Non-test module so `node --test` does not load it as a suite. Records the
// style/fg/bold calls the dialog makes so the header assertions can inspect them.

/** A spy Theme that records style/fg/bold calls made by the dialog. */
export function makeSentinelTheme() {
	const styleCalls: Array<{ text: string; options: { fg?: string; bold?: boolean } }> = [];
	const fgCalls: string[] = [];
	const boldCalls: string[] = [];
	const theme: any = {
		name: "sentinel",
		sourcePath: undefined,
		style: (text: string, options: { fg?: string; bold?: boolean }) => {
			styleCalls.push({ text, options });
			return `[S:${options.fg ?? ""}${options.bold ? ":bold" : ""}]${text}`;
		},
		fg: (_color: string, text: string) => {
			fgCalls.push(text);
			return text;
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => {
			boldCalls.push(text);
			return text;
		},
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		getFgAnsi: () => "",
		getBgAnsi: () => "",
		getColorMode: () => "truecolor" as const,
		getThinkingBorderColor: () => (text: string) => text,
		getBashModeBorderColor: () => (text: string) => text,
	};
	return { theme, styleCalls, fgCalls, boldCalls };
}
