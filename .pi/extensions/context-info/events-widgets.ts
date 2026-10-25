// ── Widget clearance on user interaction ────────────────────────
// The explain-* panels are transient: the first thing the user does dismisses
// them. TUI-only, and never fatal — a missing widget is a no-op.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTuiMode } from "./lib/mode.ts";

/** Clear the explain-* widgets (no-op outside TUI mode). */
function clearExplainWidgets(ctx: ExtensionContext): void {
	if (!isTuiMode(ctx)) return;
	ctx.ui.setWidget("explain-extensions", undefined);
	ctx.ui.setWidget("explain-prompts", undefined);
	ctx.ui.setWidget("explain-skills", undefined);
}

/** Dismiss the explain-* panels on the first user interaction. */
export function registerWidgetClearance(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		clearExplainWidgets(ctx);
	});

	pi.on("input", async (_event, ctx: ExtensionContext) => {
		clearExplainWidgets(ctx);
	});

	pi.on("user_bash", async (_event, ctx: ExtensionContext) => {
		clearExplainWidgets(ctx);
	});
}
