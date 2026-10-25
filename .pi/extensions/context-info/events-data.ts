// ── Payload → footer state mapping ──────────────────────────────
// The two event payloads that need more than a field assignment: the shared
// `supervisor:issue-data` event (which also asks for a re-render) and the
// assistant usage block behind the cache stats.

import type { FooterState } from "./footer-state.ts";

/**
 * Mirror a supervisor issue-data event onto the footer. `pi.events` is the bus
 * on purpose: a dynamic import of the supervisor would create a separate
 * module instance (jiti vs native ESM) and its module-level reference would
 * never be this one.
 */
export function applyIssueDataEvent(state: FooterState, raw: unknown): void {
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
	// Re-render through the stored TUI callback when present: re-installing the
	// whole footer via setFooter() may not render immediately, and the issue data
	// can be set then cleared (finally block) before any render happens.
	if (state.footerConfig._requestRender) {
		state.footerConfig._requestRender();
	} else {
		state.callInstallFooter();
	}
}

/** Cache read/write counts and the derived hit rate (Improvement #1). */
export function applyCacheStats(state: FooterState, usage: any): void {
	if (usage && typeof usage.cacheRead === "number") {
		state.footerConfig.cacheRead = usage.cacheRead;
	}
	if (usage && typeof usage.cacheWrite === "number") {
		state.footerConfig.cacheWrite = usage.cacheWrite;
	}
	if (usage && typeof usage.cacheRead === "number" && typeof usage.cacheWrite === "number") {
		state.footerConfig.cacheHitRate = Math.round(
			(usage.cacheRead / (usage.cacheRead + usage.cacheWrite)) * 100,
		);
	}
}

/** Streaming token sample for the TPS estimator. */
export function applyTpsSample(state: FooterState, event: any): void {
	const output = event.assistantMessageEvent?.partial?.usage?.output;
	if (typeof output === "number") {
		state.sampleTps(output);
	}
}
