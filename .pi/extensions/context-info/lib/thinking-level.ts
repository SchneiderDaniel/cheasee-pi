// ── Thinking-level probe ────────────────────────────────────────
// The footer mirrors pi's live level, never a settings-only read.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readPiSetting } from "../config.ts";

/**
 * Current thinking level pi is actually using, mirroring the stock footer's
 * source of truth (pi.getThinkingLevel()). getThinkingLevel() resolves the
 * full chain — CLI/scoped level → session-restored level → defaultThinkingLevel
 * setting → DEFAULT_THINKING_LEVEL="medium" — clamped per model, so the footer
 * never displays a stale settings-only read while pi uses another level.
 * Defensive: falls back to the setting on pi builds without getThinkingLevel().
 */
export function mirrorThinkingLevel(pi: ExtensionAPI): string {
	const live = (pi as any).getThinkingLevel?.();
	return typeof live === "string" && live !== ""
		? live
		: readPiSetting("defaultThinkingLevel") || "";
}
