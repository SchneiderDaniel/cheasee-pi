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

/**
 * Create a fresh FooterConfig with all default values.
 * Shared factory used by both the constructor and resetProperties()
 * to ensure a single source of truth for defaults.
 */
export function createDefaultFooterConfig(): FooterConfig {
	return {
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
		uiUrl: null,
		codeflowUrl: null,
		issueNumber: { value: undefined },
		issueRepo: { value: undefined },
		issueTitle: { value: undefined },
		prevCpuUsage: 0,
		prevCpuTime: 0,
		allocatedCpus: 4,
		containerDisplay: { value: "" },
	};
}

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

	timerInterval: ReturnType<typeof setInterval> | null = null;

	/** Disposed flag: set true when state is replaced on session transition.
	 *  Prevents stale ctx access from timer callback after runner invalidation. */
	disposed = false;

	ctx: ExtensionContext;
	installFooterCb: InstallFooterFn;

	constructor(ctx: ExtensionContext, installFooterCb: InstallFooterFn = () => {}) {
		this.ctx = ctx;
		this.installFooterCb = installFooterCb;
		this.footerConfig = createDefaultFooterConfig();
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
				// Use lightweight re-render instead of full footer re-install
				// to avoid flickering. _requestRender is set by footer factory
				// after first install.
				if (this.footerConfig._requestRender) {
					this.footerConfig._requestRender();
				} else {
					this.callInstallFooter();
				}
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

	// ── Response-scoped resets ────────────────────────────────────

	/**
	 * Start a fresh response: drop the rolling window and the displayed rate.
	 *
	 * This is the *only* response-scoped reset. It used to be inferred from a
	 * decreasing sample, which silently dropped legitimate samples whenever the
	 * estimate dipped (thinking-only deltas, a shrinking tool-call buffer). A
	 * real `message_start` for an assistant message is an unambiguous boundary.
	 */
	beginResponse(): void {
		this.footerConfig.tpsSamples.length = 0;
		this.footerConfig.lastComputedTps.value = null;
	}

	// ── TPS sampling ──────────────────────────────────────────────

	sampleTps(tokens: number | undefined): void {
		if (typeof tokens !== "number" || tokens < 0) return;
		const now = Date.now();
		this.footerConfig.tpsSamples.push({ time: now, cumulativeTokens: tokens });
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
		if (this.disposed) return;
		this.footerConfig.toolCallCount.value++;
		this.callInstallFooter();
	}

	// ── Cache-scoped reset ────────────────────────────────────────

	/**
	 * Drop the cache counts and the derived rate together, so the footer can
	 * never show a percentage computed from a different model's usage record.
	 */
	resetCacheStats(): void {
		this.footerConfig.cacheRead = undefined;
		this.footerConfig.cacheWrite = undefined;
		this.footerConfig.cacheHitRate = undefined;
	}

	// ── State reset (for session boundaries) ──────────────────────

	resetProperties(): void {
		this.config = null;

		Object.assign(this.footerConfig, createDefaultFooterConfig());
	}
}
