// ── Payload → footer state mapping ──────────────────────────────
// The payloads that need more than a field assignment: the shared issue-data
// bus event (which also asks for a re-render), the assistant usage block behind
// the cache stats, and the streamed message behind the TPS estimate.
//
// These functions are translators only. The metric policy lives in the pure
// leaf modules `cache-stats.ts` and `stream-estimate.ts`.

import type { FooterState } from "./footer-state.ts";
import type { IssueDataEvent } from "../lib/issue-data-event.ts";
import { computeCacheHitRate } from "./cache-stats.ts";
import { estimateStreamedTokens } from "./stream-estimate.ts";

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

/**
 * Cache read/write counts and the derived hit rate, written together.
 *
 * Atomic on purpose: a usage record that cannot produce a rate (no `input`,
 * zero denominator, partial fields) must not leave the footer showing fresh
 * counts next to a stale percentage — or worse, counts labelled with the rate
 * of a previous message. Nothing is written unless the rate is available.
 */
export function applyCacheStats(state: FooterState, usage: any): void {
	const rate = computeCacheHitRate(usage);
	if (rate === undefined) return;
	state.footerConfig.cacheRead = usage.cacheRead;
	state.footerConfig.cacheWrite = usage.cacheWrite;
	state.footerConfig.cacheHitRate = rate;
}

/**
 * Streaming token sample for the TPS estimator.
 *
 * Derived from the streamed content, not from `assistantMessageEvent.partial
 * .usage.output`: providers that withhold incremental output usage never let
 * that number move, which is the reported `-- t/s` bug. A zero-length stream
 * contributes no sample so the estimator cannot divide 0 by an elapsed time.
 */
export function applyTpsSample(state: FooterState, event: any): void {
	const estimate = estimateStreamedTokens(event?.message);
	if (estimate > 0) {
		state.sampleTps(estimate);
	}
}
