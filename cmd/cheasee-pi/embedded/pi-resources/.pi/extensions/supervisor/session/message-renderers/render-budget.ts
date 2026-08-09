import { Text } from "@earendil-works/pi-tui";
import type { RendererFn } from "./types.ts";

/** Budget exceeded: warning one-liner with tool/token counts. */
export const renderBudgetExceeded: RendererFn = (message, _options, theme) => {
	const rawDetails = (message as any).details;
	const agentName = rawDetails.agentName || "";
	const tc = rawDetails.toolCount ?? 0;
	const tok = rawDetails.tokenCount ?? 0;
	const warning = `⚠ ${agentName} — budget exceeded (${tc} tools, ${tok} tokens)`;
	return new Text(theme.fg("warning", warning), 1, 1);
};
