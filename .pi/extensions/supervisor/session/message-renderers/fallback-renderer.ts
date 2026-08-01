import { Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { RendererFn } from "./types.ts";

/**
 * Unknown / no eventType. Replicates the old switch default case:
 * Markdown for string content, placeholder Text otherwise.
 */
export const fallbackRenderer: RendererFn = (message, _options, _theme) => {
	if (typeof message.content === "string") {
		const mdTheme = getMarkdownTheme();
		return new Markdown(message.content, 1, 1, mdTheme);
	}
	return new Text("(unhandled supervisor message)", 1, 1);
};
