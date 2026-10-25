// ── Mode guard ─────────────────────────────────────────────────
// UI mutations are TUI-only. `ctx.mode` exists in pi >=0.78.1; anything else
// (including builds without it) is treated as TUI, the pre-mode behaviour.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function isTuiMode(ctx: ExtensionContext): boolean {
	const mode = (ctx as any).mode as string | undefined;
	return mode === undefined || mode === "tui";
}
