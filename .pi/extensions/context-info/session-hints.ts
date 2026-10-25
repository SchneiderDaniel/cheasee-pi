// ── Session-start details ───────────────────────────────────────
// The two value probes the session_start handler needs beyond the footer
// state itself: the session id and the startup notifies.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

/** Session id from the `<timestamp>_<uuid>.jsonl` session file name. */
export function resolveSessionId(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return "unknown";
	const match = sessionFile.match(/_([0-9a-f-]+)\.jsonl$/i);
	return match ? match[1]! : "unknown";
}

/**
 * Startup notifies: the info hint, then the live CodeFlow URL (resolved once
 * per session by the caller — same source the CLI uses). The OSC 8 wrap is
 * gated on terminal capabilities; an unresolvable workspace posts one hint.
 */
export function notifyStartupHints(ctx: ExtensionContext, codeflowUrl: string | undefined): void {
	ctx.ui.notify("For Info:  /cheasee-pi-info", "info");
	if (!codeflowUrl) return;
	const caps = getCapabilities();
	ctx.ui.notify(
		"CodeFlow:  " + (caps.hyperlinks ? hyperlink(codeflowUrl, codeflowUrl) : codeflowUrl),
		"info",
	);
}
