import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { RendererFn } from "./types.ts";

/** Phase change: accent-colored first line + Markdown body. */
export const renderPhaseChange: RendererFn = (message, _options, theme) => {
	const rawDetails = (message as any).details;
	const agentName = rawDetails.agentName as string;
	const phase = rawDetails.phase as string;
	const text = `⏳ ${agentName} — ${phase} phase`;
	if (typeof message.content === "string" && message.content !== text) {
		// Full content with extra info
		const firstNl = message.content.indexOf("\n");
		if (firstNl > 0) {
			const statusLine = message.content.slice(0, firstNl);
			const rest = message.content.slice(firstNl + 1);
			const c = new Container();
			c.addChild(new Text(theme.fg("accent", statusLine), 1, 0));
			if (rest.trim()) {
				const mdTheme = getMarkdownTheme();
				c.addChild(new Markdown(rest, 1, 0, mdTheme));
			}
			return c;
		}
		const mdTheme = getMarkdownTheme();
		return new Markdown(message.content, 1, 0, mdTheme);
	}
	return new Text(theme.fg("accent", text), 1, 0);
};
