// ── Payload → footer state mapping ──────────────────────────────
// The two event payloads that need more than a field assignment: the shared
// issue-data bus event (which also asks for a re-render) and the assistant
// usage block behind the cache stats.

import type { FooterState } from "./footer-state.ts";
import type { IssueDataEvent } from "../lib/issue-data-event.ts";

/**
 * Mirror a supervisor issue-data event onto the footer. `pi.events` is the bus
 * on purpose: a dynamic import of the supervisor would create a separate
 * module instance (jiti vs native ESM) and its module-level reference would
 * never be this one. The payload shape is declared in the shared contract
 * module, so producer and consumer cannot drift.
 *
 * Runtime tolerance: the bus only ever delivers `unknown`. The listener runs
 * it through `parseIssueDataEvent` first, so `undefined` here means "not our
 * payload" — nothing changed, so nothing is rendered. Only `null` clears.
 */
export function applyIssueDataEvent(state: FooterState, payload: IssueDataEvent | undefined): void {
	if (payload === undefined) return;
	if (payload === null) {
		state.footerConfig.issueNumber.value = undefined;
		state.footerConfig.issueRepo.value = undefined;
		state.footerConfig.issueTitle.value = undefined;
	} else {
		state.footerConfig.issueNumber.value = payload.issueNumber;
		state.footerConfig.issueRepo.value = payload.issueRepo;
		state.footerConfig.issueTitle.value = payload.issueTitle;
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
