import { Text } from "@earendil-works/pi-tui";
import type { RendererFn } from "./types.ts";

/** Tool start: accent-colored one-liner. */
export const renderToolStart: RendererFn = (message, _options, theme) => {
	const rawDetails = (message as any).details;
	const agentName = rawDetails.agentName as string;
	const toolName = rawDetails.toolName as string;
	const args = rawDetails.args as string;
	const text = args ? `⏳ ${agentName} — ${toolName} ${args}` : `⏳ ${agentName} — ${toolName}`;
	return new Text(theme.fg("accent", text), 1, 0);
};
