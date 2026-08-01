import { Container } from "@earendil-works/pi-tui";
import { renderThinkingBlock } from "../../lib/render-helpers.ts";
import type { RendererFn } from "./types.ts";

/** Thinking block (markdown content, thinkingText color + italic). */
export const renderThinking: RendererFn = (message, _options, theme) => {
	const rawDetails = (message as any).details;
	const content = rawDetails.content || rawDetails.thinkingText || "";
	const c = new Container();
	renderThinkingBlock(c, content, theme);
	return c;
};
