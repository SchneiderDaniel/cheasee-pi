/**
 * FooterState — Encapsulated state container for context-info footer
 *
 * Consolidates all mutable state that was previously spread across
 * closure variables, ref objects, and mutable arrays in index.ts.
 *
 * Events delegate to this class, which provides a single source of truth
 * for footer rendering, timer management, TPS sampling, and tool call tracking.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextStatusBarConfig, FooterConfig } from "./types.js";

/** Callback signature for installing the footer */
export type InstallFooterFn = (
	ctx: ExtensionContext,
	config: ContextStatusBarConfig | null,
	footerConfig: FooterConfig,
) => void;

export class FooterState {
	// ── Footer data (shared reference for mutation) ───────────────
	footerConfig: FooterConfig;

	// ── State properties ──────────────────────────────────────────
	config: ContextStatusBarConfig | null = null;
	emitted = false;
	lastSampledOutput: number | undefined = undefined;

	timerInterval: ReturnType<typeof setInterval> | null = null;

	/** Disposed flag: set true when state is replaced on session transition.
	 *  Prevents stale ctx access from timer callback after runner invalidation. */
	disposed = false;

	ctx: ExtensionContext;
	installFooterCb: InstallFooterFn;

	constructor(ctx: ExtensionContext, installFooterCb: InstallFooterFn = () => {}) {
		this.ctx = ctx;
		this.installFooterCb = installFooterCb;
		this.footerConfig = {
			worktreeName: null,
			thinkingLevel: "",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
			cacheHitRate: undefined,
			sessionName: undefined,
			trustStatus: undefined,
			sessionId: "",
			issueNumber: { value: undefined },
			issueRepo: { value: undefined },
			issueTitle: { value: undefined },
		};
	}

	/** Mark state as disposed — stops timer and prevents any further callInstallFooter */
	dispose(): void {
		this.disposed = true;
		this.stopTimer();
	}

	/** Invoke the footer install callback with current context and footerConfig.
	 *  No-op if state is disposed (prevents stale ctx access after session replacement). */
	callInstallFooter(): void {
		if (this.disposed) return;
		this.installFooterCb(this.ctx, this.config, this.footerConfig);
	}

	// ── Timer management ─────────────────────────────────────────

	startTimer(): void {
		this.stopTimer();
		this.timerInterval = setInterval(() => {
			if (this.disposed || !this.config) return;
			try {
				this.callInstallFooter();
			} catch (e) {
				// If ctx is stale from session replacement, stop silently
				this.disposed = true;
				this.stopTimer();
			}
		}, 1000);
	}

	stopTimer(): void {
		if (this.timerInterval !== null) {
			clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
	}

	// ── TPS sampling ──────────────────────────────────────────────

	sampleTps(output: number | undefined): void {
		if (typeof output !== "number" || output < 0) return;
		// Detect reset between responses (new response starts from 0)
		if (typeof this.lastSampledOutput === "number" && output < this.lastSampledOutput) {
			this.footerConfig.tpsSamples.length = 0;
		}
		this.lastSampledOutput = output;
		const now = Date.now();
		this.footerConfig.tpsSamples.push({ time: now, cumulativeTokens: output });
		// Prune samples older than 30s
		const cutoff = now - 30_000;
		while (
			this.footerConfig.tpsSamples.length > 0 &&
			this.footerConfig.tpsSamples[0]!.time < cutoff
		) {
			this.footerConfig.tpsSamples.shift();
		}
	}

	// ── Tool call tracking ────────────────────────────────────────

	addToolCall(): void {
		this.footerConfig.toolCallCount.value++;
		this.callInstallFooter();
	}

	// ── State reset (for session boundaries) ──────────────────────

	resetProperties(): void {
		this.config = null;
		this.emitted = false;
		this.lastSampledOutput = undefined;

		this.footerConfig.worktreeName = null;
		this.footerConfig.thinkingLevel = "";
		this.footerConfig.tpsSamples.length = 0;
		this.footerConfig.lastComputedTps.value = null;
		this.footerConfig.lastContextWindow.value = undefined;
		this.footerConfig.toolCallCount.value = 0;
		this.footerConfig.cacheRead = undefined;
		this.footerConfig.cacheWrite = undefined;
		this.footerConfig.cacheHitRate = undefined;
		this.footerConfig.sessionName = undefined;
		this.footerConfig.trustStatus = undefined;
		this.footerConfig.sessionId = "";
		this.footerConfig.issueNumber.value = undefined;
		this.footerConfig.issueRepo.value = undefined;
		this.footerConfig.issueTitle.value = undefined;
	}
}
