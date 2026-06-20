/**
 * context-info — Rich status bar with git branch, model info, token usage, and TPS
 *
 * Replaces pi's default footer with an info-dense status line.
 * Shows: git branch, active model, thinking level, session timer,
 * token usage with thresholds, and tokens-per-second during streaming.
 * Works with any theme. Use /explain-extensions to list all active extensions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, readPiSetting } from "./config.ts";
import { getWorktreeName } from "./git-helpers.ts";
import { tryEmit } from "./telemetry.ts";
import { installFooter } from "./footer.ts";
import { FooterState } from "./footer-state.ts";
import { registerCheaseePiInfo } from "./cheasee-pi-info.ts";
import { listLocalExtensions } from "./extensions.ts";
import type { ExtensionMeta } from "./extensions.ts";
import { listLocalPrompts } from "./prompts.ts";
import type { PromptMeta } from "./prompts.ts";
import { listLocalSkills } from "./skills.ts";
import type { SkillMeta } from "./skills.ts";
import { createExplainCommand, formatWithWordWrap } from "./explain.ts";

// ── Module-level state reference for exported supervisor helpers ───
// Allows setSupervisorIssueData/clearSupervisorIssueData to access
// the current FooterState without exposing the state object directly.
// Updated on session_start, cleared on session_shutdown.
let stateRef: FooterState | undefined;

/**
 * Set supervisor issue data on the footer config.
 * Called by supervisor pipeline after successful issue fetch.
 * Mutates FooterConfig in-place and triggers immediate re-render.
 * Graceful no-op if state is disposed or not yet initialized.
 */
export function setSupervisorIssueData(
	issueNumber: number,
	issueRepo: string,
	issueTitle: string,
): void {
	const s = stateRef;
	if (!s || s.disposed) return;
	s.footerConfig.issueNumber.value = issueNumber;
	s.footerConfig.issueRepo.value = issueRepo;
	s.footerConfig.issueTitle.value = issueTitle;
	s.callInstallFooter();
}

/**
 * Clear supervisor issue data from the footer config.
 * Called by supervisor pipeline on completion (any outcome).
 * Resets all three fields to undefined and triggers immediate re-render.
 * Idempotent — safe to call when no issue data is set.
 */
export function clearSupervisorIssueData(): void {
	const s = stateRef;
	if (!s || s.disposed) return;
	s.footerConfig.issueNumber.value = undefined;
	s.footerConfig.issueRepo.value = undefined;
	s.footerConfig.issueTitle.value = undefined;
	s.callInstallFooter();
}

export default function contextInfo(pi: ExtensionAPI): void {
	// FooterState — single source of truth for all mutable state
	// Initialized per session in session_start handler
	let state: FooterState | undefined;

	// ── Commands ────────────────────────────────────────────────────

	// explain-prompts: multi-line with wordWrap
	createExplainCommand<PromptMeta>(pi, "explain-prompts", "prompt", listLocalPrompts, {
		formatItem: formatWithWordWrap,
	});

	// explain-skills: multi-line with wordWrap
	createExplainCommand<SkillMeta>(pi, "explain-skills", "skill", listLocalSkills, {
		formatItem: formatWithWordWrap,
	});

	// explain-extensions: single-line with error handling
	createExplainCommand<ExtensionMeta>(pi, "explain-extensions", "extension", listLocalExtensions, {
		formatItem: (item, { accent, dim }) => {
			if (item.error) {
				return [accent("  " + item.name) + dim("  error: " + item.error)];
			}
			const firstLine = (item.description ?? "(no description)").split("\n")[0].trim();
			return [accent("  " + item.name) + dim("  " + firstLine)];
		},
	});

	// ── cheasee-pi-info command ────────────────────────────
	registerCheaseePiInfo(pi);

	// ── Cross-extension event listeners (shared pi.events) ─────────
	// Listen for supervisor issue data events instead of dynamic import.
	// Dynamic import from supervisor creates a separate module instance
	// (jiti vs native ESM), so module-level stateRef is never set there.
	pi.events.on("supervisor:issue-data", (raw: unknown) => {
		if (!state || state.disposed) return;
		if (raw === null) {
			state.footerConfig.issueNumber.value = undefined;
			state.footerConfig.issueRepo.value = undefined;
			state.footerConfig.issueTitle.value = undefined;
		} else if (typeof raw === "object" && raw !== null) {
			const data = raw as { issueNumber: number; issueRepo: string; issueTitle: string };
			state.footerConfig.issueNumber.value = data.issueNumber;
			state.footerConfig.issueRepo.value = data.issueRepo;
			state.footerConfig.issueTitle.value = data.issueTitle;
		}
		// Trigger re-render through stored TUI callback if available.
		// This avoids re-installing the entire footer via setFooter() which
		// may not trigger an immediate render — causing a race where issue
		// data is set and cleared (via finally block) before any render occurs.
		if (state.footerConfig._requestRender) {
			state.footerConfig._requestRender();
		} else {
			state.callInstallFooter();
		}
	});

	// ── Hooks ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Dispose previous state to prevent stale ctx usage after
		// reload/newSession/fork/switchSession. The old state's timer closure
		// holds a captured ctx that becomes invalid on session replacement.
		if (state) {
			state.dispose();
		}
		state = new FooterState(ctx, installFooter);
		stateRef = state;
		state.resetProperties();
		state.config = loadConfig();

		// Detect worktree each session — git worktree can change across sessions
		state.footerConfig.worktreeName = getWorktreeName(ctx.cwd);
		// Deferred I/O — read pi settings on first session
		if (!state.footerConfig.thinkingLevel) {
			state.footerConfig.thinkingLevel = readPiSetting("defaultThinkingLevel") || "";
		}

		if (state.config === null) {
			// Mode guard: only clear UI elements in TUI mode
			// ctx.mode is available in pi >=0.78.1; cast for backward compat
			const mode = (ctx as any).mode as string | undefined;
			if (mode === undefined || mode === "tui") {
				ctx.ui.setFooter(undefined);
				ctx.ui.setStatus("contextUsage", undefined);
			}
			state.stopTimer();
			return;
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

		// Install custom footer (mode-guarded inside installFooter)
		state.callInstallFooter();

		// Start live timer (timer itself has its own mode guard via installFooter call)
		state.startTimer();

		// Mode guard: only set working indicator and widgets in TUI mode
		const mode = (ctx as any).mode as string | undefined;
		if (mode === undefined || mode === "tui") {
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
		let sessionId = "unknown";
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) {
			// Filename format: <timestamp>_<uuid>.jsonl
			const match = sessionFile.match(/_([0-9a-f-]+)\.jsonl$/i);
			if (match) sessionId = match[1]!;
		}
		state.footerConfig.sessionId = sessionId;

		// ── Startup hint ────────────────────────────────────
		ctx.ui.notify("For Info:  /cheasee-pi-info", "info");
	});

	// Clear explain-* widgets on first user interaction
	function clearExplainWidgets(ctx: ExtensionContext) {
		const mode = (ctx as any).mode as string | undefined;
		if (mode === undefined || mode === "tui") {
			ctx.ui.setWidget("explain-extensions", undefined);
			ctx.ui.setWidget("explain-prompts", undefined);
			ctx.ui.setWidget("explain-skills", undefined);
		}
	}

	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		clearExplainWidgets(ctx);
	});

	pi.on("input", async (_event, ctx: ExtensionContext) => {
		clearExplainWidgets(ctx);
	});

	pi.on("user_bash", async (_event, ctx: ExtensionContext) => {
		clearExplainWidgets(ctx);
	});

	pi.on("thinking_level_select", async (event, ctx: ExtensionContext) => {
		if (!state) return;
		state.footerConfig.thinkingLevel = event.level;
		if (state.config) {
			state.callInstallFooter();
		}
	});

	pi.on("model_select", async (event, ctx: ExtensionContext) => {
		if (!state) return;
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			state.footerConfig.lastContextWindow.value = cw;
		}
		// Reset cache hit rate on model change (per research finding — cache keys are provider/model-specific)
		state.footerConfig.cacheHitRate = undefined;
		// Re-read session name (in case setSessionName was called mid-session)
		state.footerConfig.sessionName = pi.getSessionName();
		if (state.config) {
			state.callInstallFooter();
		}
		tryEmit(ctx, state);
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		if (!state || !state.config) return;
		// Re-read session name (in case setSessionName was called mid-session)
		state.footerConfig.sessionName = pi.getSessionName();
		state.callInstallFooter();
	});

	pi.on("message_end", async (event, ctx: ExtensionContext) => {
		if (!state) return;
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		// Capture cache stats from raw event usage
		const eventUsage = msg.usage;
		if (eventUsage && typeof eventUsage.cacheRead === "number") {
			state.footerConfig.cacheRead = eventUsage.cacheRead;
		}
		if (eventUsage && typeof eventUsage.cacheWrite === "number") {
			state.footerConfig.cacheWrite = eventUsage.cacheWrite;
		}
		// Compute cache hit rate (Improvement #1)
		if (
			eventUsage &&
			typeof eventUsage.cacheRead === "number" &&
			typeof eventUsage.cacheWrite === "number"
		) {
			state.footerConfig.cacheHitRate = Math.round(
				(eventUsage.cacheRead / (eventUsage.cacheRead + eventUsage.cacheWrite)) * 100,
			);
		}
		const usage = ctx.getContextUsage();
		if (usage && typeof usage.tokens === "number" && usage.tokens > 0) {
			tryEmit(ctx, state);
		}
	});

	pi.on("message_update", async (event: any, _ctx: ExtensionContext) => {
		if (!state) return;
		// Sample streaming output tokens for TPS estimation
		const output = event.assistantMessageEvent?.partial?.usage?.output;
		if (typeof output === "number") {
			state.sampleTps(output);
		}
	});

	pi.on("tool_execution_end", async () => {
		if (state) {
			state.addToolCall();
		}
	});

	pi.on("session_shutdown", async () => {
		if (state) {
			state.stopTimer();
		}
		stateRef = undefined;
	});
}

// Named export alongside default — needed by tests for named import compatibility
export { contextInfo };
