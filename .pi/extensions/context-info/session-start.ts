// ── session_start: build and install the footer ──────────────────
// One job: from a fresh ExtensionContext, construct the FooterState, prime it
// (worktree, thinking level, trust, session name, service URLs) and install
// the footer. Returns `null` after disposing when the extension is disabled
// by config, so the caller never holds a dead state.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { codeflowUrl } from "./codeflow.ts";
import { uiUrl } from "./ui.ts";
import { installFooter } from "./footer.ts";
import { FooterState } from "./footer-state.ts";
import { isTuiMode } from "./lib/mode.ts";
import { getWorktreeName } from "./lib/worktree-name.ts";
import { mirrorThinkingLevel } from "./lib/thinking-level.ts";
import { notifyStartupHints, resolveSessionId } from "./session-hints.ts";

export async function startFooterSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<FooterState | null> {
	const state = new FooterState(ctx, installFooter);
	state.resetProperties();
	state.config = loadConfig();

	// Detect worktree each session — git worktree can change across sessions
	state.footerConfig.worktreeName = getWorktreeName(ctx.cwd);
	// Mirror pi's live thinking level from session start (resolve CLI/scoped,
	// session-restored, setting, and DEFAULT_THINKING_LEVEL via getThinkingLevel)
	state.footerConfig.thinkingLevel = mirrorThinkingLevel(pi);

	if (state.config === null) {
		// Mode guard: only clear UI elements in TUI mode
		if (isTuiMode(ctx)) {
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus("contextUsage", undefined);
		}
		state.dispose();
		return null;
	}

	const cw = ctx.model?.contextWindow;
	if (typeof cw === "number" && cw > 0) {
		state.footerConfig.lastContextWindow.value = cw;
	}

	// ── Session name (Improvement #2) ──────────────────────
	state.footerConfig.sessionName = pi.getSessionName();

	// ── Project trust status (Improvement #4) ──────────────
	// ctx.isProjectTrusted() is available in pi >=0.79.1; cast for backward compat
	const trusted = (ctx as any).isProjectTrusted?.();
	if (trusted === true) {
		state.footerConfig.trustStatus = "trusted";
	} else if (trusted === false) {
		state.footerConfig.trustStatus = "untrusted";
	} else {
		state.footerConfig.trustStatus = undefined;
	}

	// ── Service links (footer row 3) ───────────────────────
	// Resolve both URLs once per session, BEFORE installing the footer, so the
	// first render already carries the links (no post-install async gap) and the
	// values stay byte-stable across re-renders (TuiAltScreen diffs raw lines,
	// escape sequences included). The CodeFlow value is reused for the startup
	// notify below — one resolution, no divergence.
	state.footerConfig.uiUrl = await uiUrl(ctx.cwd);
	state.footerConfig.codeflowUrl = await codeflowUrl(ctx.cwd);

	// Install custom footer (mode-guarded inside installFooter)
	state.callInstallFooter();

	// Start live timer (timer itself has its own mode guard via installFooter call)
	state.startTimer();

	// Mode guard: only set working indicator in TUI mode
	if (isTuiMode(ctx)) {
		// Custom working indicator — subtle dot pulse
		ctx.ui.setWorkingIndicator({
			frames: [
				ctx.ui.theme.fg("dim", "·"),
				ctx.ui.theme.fg("muted", "•"),
				ctx.ui.theme.fg("accent", "●"),
				ctx.ui.theme.fg("muted", "•"),
			],
			intervalMs: 150,
		});
	}

	// ── Session ID ────────────────────────────────────────
	state.footerConfig.sessionId = resolveSessionId(ctx);

	// ── Startup hints ─────────────────────────────────────
	notifyStartupHints(ctx, state.footerConfig.codeflowUrl ?? undefined);

	return state;
}
