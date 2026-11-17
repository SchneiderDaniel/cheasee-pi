/**
 * Pure visual helpers for context-info extension
 */

import type { SubtleColorToken, ThresholdEntry, TpsSample, UsageColorToken } from "./types.js";
import { formatTokens } from "../lib/format-tokens.ts";

// ─── Appearance-aware secondary text ────────────────────────────

/**
 * Pick the low-emphasis token for readable secondary text. Light terminals
 * render `dim` too faint, so use the higher-contrast `muted` there. Anything
 * else — including `undefined` from pre-1.0 themes — keeps `dim`.
 */
export function resolveSubtleColor(appearance: "dark" | "light" | undefined): SubtleColorToken {
	return appearance === "light" ? "muted" : "dim";
}

// ─── Semantic tokens for threshold levels ────────────────────────

const THRESHOLD_TOKENS: UsageColorToken[] = ["success", "warning", "error"];

/** Format elapsed ms → "⏱ Xh Ym Zs" */
export function formatSessionTimer(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `\u23f1 ${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `\u23f1 ${minutes}m ${seconds}s`;
	return `\u23f1 ${seconds}s`;
}

/** Pick semantic theme token for a token count given thresholds. */
export function pickThresholdColor(tokens: number, thresholds: ThresholdEntry[]): UsageColorToken {
	const sorted = [...thresholds].sort((a, b) => {
		if (a.maxTokens === null) return 1;
		if (b.maxTokens === null) return -1;
		return a.maxTokens - b.maxTokens;
	});
	for (let i = 0; i < sorted.length; i++) {
		const entry = sorted[i]!;
		if (entry.maxTokens === null) return "error";
		if (tokens <= entry.maxTokens) {
			return THRESHOLD_TOKENS[Math.min(i, THRESHOLD_TOKENS.length - 1)] ?? "error";
		}
	}
	return "error";
}

// ─── TPS helpers ────────────────────────────────────────────────

/** Compute tokens per second from rolling buffer (30s window) */
export function computeTps(samples: TpsSample[]): number | null {
	if (samples.length < 2) return null;

	const now = Date.now();
	const cutoff = now - 30_000;

	// Filter to 30s window
	const active = samples.filter((s) => s.time >= cutoff);
	if (active.length < 2) return null;

	const first = active[0]!;
	const last = active[active.length - 1]!;
	const tokenDelta = last.cumulativeTokens - first.cumulativeTokens;
	const timeDelta = last.time - first.time;

	if (timeDelta <= 0) return null;
	if (tokenDelta <= 0) return null;

	return (tokenDelta / timeDelta) * 1000;
}

/** Format TPS value to display string */
export function formatTps(tps: number | null): string {
	if (tps === null) return "-- t/s";
	if (tps < 0.1) return "0.0 t/s";
	if (tps > 999.9) return `${Math.round(tps)} t/s`;
	return `${tps.toFixed(1)} t/s`;
}

/**
 * Format the streaming rate, marking it as an estimate.
 *
 * The value is derived from streamed character counts / 4, so it is a rough
 * proxy rather than a provider-reported token count. The `~` says so; a
 * `null` rate keeps the unmarked `-- t/s` because there is nothing to qualify.
 */
export function formatEstimatedTps(tps: number | null | undefined): string {
	if (tps === null || tps === undefined || Number.isNaN(tps)) return "-- t/s";
	return `~${formatTps(tps)}`;
}

/** Format cache stats: 📦 cacheRead/cacheWrite */
export function formatCacheStats(
	cacheRead: number | undefined | null,
	cacheWrite: number | undefined | null,
): string {
	if (
		cacheRead === undefined ||
		cacheRead === null ||
		cacheWrite === undefined ||
		cacheWrite === null
	) {
		return "\u{1F4E6} --/--";
	}
	return `\u{1F4E6} ${formatTokens(cacheRead)}/${formatTokens(cacheWrite)}`;
}

/**
 * Format the cache hit rate: 75 → "Cache Hit Rate: 75%".
 *
 * The label is spelled out — the old two-letter abbreviation explained nothing —
 * and stays visible when the rate is unavailable, so the reader can tell "no
 * data" apart from "segment not rendered". The percentage is the cache-read
 * share of reported prompt tokens; see `cache-stats.ts` for the denominator.
 */
export function formatCacheHitRate(rate: number | undefined | null): string {
	if (rate === undefined || rate === null || Number.isNaN(rate)) return "Cache Hit Rate: --";
	return `Cache Hit Rate: ${Math.round(rate)}%`;
}

/** Format container CPU percentage for footer display */
export function formatCpuPct(pct: number): string {
	if (pct < 0.1) return "0%";
	if (pct > 99.5) return "100%";
	return `${pct.toFixed(0)}%`;
}
