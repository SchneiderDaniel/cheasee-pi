// ─── Simple renderers (one-liner + phase-change) ────────────────────
// Folded from render-{compaction,error,budget,tool-start,thinking,phase-change}.ts:
// each has exactly one importer (index.ts) and no substitution value, so the
// per-renderer split only scattered the dispatch table's story.

import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { renderThinkingBlock } from "../../lib/render-helpers.ts";
import type { RendererFn } from "./types.ts";

/** Payload fields vary per eventType; the six producer shapes are unmodelled (see types.ts). */
const readRawDetails = (message: Parameters<RendererFn>[0]): Record<string, any> =>
	(message as any).details;

/** Compaction: muted one-liner. */
export const renderCompaction: RendererFn = (_message, _options, theme) =>
	new Text(theme.fg("muted", "⚠ compacted"), 1, 1);

/** Error: red one-liner with optional tool name + reason. */
export const renderError: RendererFn = (message, _options, theme) => {
	const rawDetails = readRawDetails(message);
	const toolName = rawDetails.toolName ? `${rawDetails.toolName}: ` : "";
	const errText = `✗ ${toolName}${rawDetails.errorReason || "Unknown error"}`;
	return new Text(theme.fg("error", errText), 1, 1);
};

/** Budget exceeded: warning one-liner with tool/token counts. */
export const renderBudgetExceeded: RendererFn = (message, _options, theme) => {
	const rawDetails = readRawDetails(message);
	const agentName = rawDetails.agentName || "";
	const tc = rawDetails.toolCount ?? 0;
	const tok = rawDetails.tokenCount ?? 0;
	const warning = `⚠ ${agentName} — budget exceeded (${tc} tools, ${tok} tokens)`;
	return new Text(theme.style(warning, { fg: "warning" }), 1, 1);
};

/** Tool start: accent-colored one-liner. */
export const renderToolStart: RendererFn = (message, _options, theme) => {
	const rawDetails = readRawDetails(message);
	const agentName = rawDetails.agentName as string;
	const toolName = rawDetails.toolName as string;
	const args = rawDetails.args as string;
	const text = args ? `⏳ ${agentName} — ${toolName} ${args}` : `⏳ ${agentName} — ${toolName}`;
	return new Text(theme.fg("accent", text), 1, 0);
};

/** Thinking block (markdown content, thinkingText color + italic). */
export const renderThinking: RendererFn = (message, _options, theme) => {
	const rawDetails = readRawDetails(message);
	const content = rawDetails.content || rawDetails.thinkingText || "";
	const c = new Container();
	renderThinkingBlock(c, content, theme);
	return c;
};

/** Phase change: accent-colored first line + Markdown body. */
export const renderPhaseChange: RendererFn = (message, _options, theme) => {
	const rawDetails = readRawDetails(message);
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
