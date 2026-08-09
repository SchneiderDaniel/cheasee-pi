import { Text } from "@earendil-works/pi-tui";
import type { RendererFn } from "./types.ts";

/** Compaction: muted one-liner. */
export const renderCompaction: RendererFn = (_message, _options, theme) =>
	new Text(theme.fg("muted", "⚠ compacted"), 1, 1);
