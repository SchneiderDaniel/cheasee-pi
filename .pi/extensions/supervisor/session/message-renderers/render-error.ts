import { Text } from "@earendil-works/pi-tui";
import type { RendererFn } from "./types.ts";

/** Error: red one-liner with optional tool name + reason. */
export const renderError: RendererFn = (message, _options, theme) => {
	const rawDetails = (message as any).details;
	const toolName = rawDetails.toolName ? `${rawDetails.toolName}: ` : "";
	const errText = `✗ ${toolName}${rawDetails.errorReason || "Unknown error"}`;
	return new Text(theme.fg("error", errText), 1, 1);
};
