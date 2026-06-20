/**
 * Pure visual helpers for context-info extension
 */

import type { ThresholdEntry, TpsSample } from "./types.js";

// ─── Hex colors for threshold levels ─────────────────────────────

const THRESHOLD_HEX_COLORS = [
	"#50fa7b", // green (neonMint)
	"#ff6d00", // orange (safetyOrange)
	"#ff5252", // red (coral)
];

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

/** Format token count: 1200 → "1.2K", 1200000 → "1.2M" */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Apply hex foreground color via ANSI truecolor */
export function fgHex(hex: string, text: string): string {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) return text;
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return text;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** Pick threshold for given token count and return hex color */
export function pickThresholdHex(tokens: number, thresholds: ThresholdEntry[]): string {
	const sorted = [...thresholds].sort((a, b) => {
		if (a.maxTokens === null) return 1;
		if (b.maxTokens === null) return -1;
		return a.maxTokens - b.maxTokens;
	});
	const colors = THRESHOLD_HEX_COLORS;
	for (let i = 0; i < sorted.length; i++) {
		const entry = sorted[i];
		if (entry.maxTokens === null) return colors[Math.min(i, colors.length - 1)] ?? "#ff5252";
		if (tokens <= entry.maxTokens) return colors[Math.min(i, colors.length - 1)] ?? "#ff5252";
	}
	return colors[colors.length - 1] ?? "#ff5252";
}

// ─── Thinking level → icon/color ────────────────────────────────

export function thinkingIcon(level: string | undefined): string {
	switch (level) {
		case "off":
			return "○";
		case "minimal":
			return "◐";
		case "low":
			return "◑";
		case "medium":
			return "◒";
		case "high":
			return "◓";
		case "xhigh":
			return "●";
		default:
			return "·";
	}
}

export function thinkingColor(level: string | undefined): string {
	switch (level) {
		case "off":
			return "dim";
		case "minimal":
			return "dim";
		case "low":
			return "muted";
		case "medium":
			return "accent";
		case "high":
			return "warning";
		case "xhigh":
			return "error";
		default:
			return "dim";
	}
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

/** Format cache hit rate: 75 → "CH: 75%", undefined → "" */
export function formatCacheHitRate(rate: number | undefined): string {
	if (rate === undefined || rate === null || Number.isNaN(rate)) return "";
	return `CH: ${Math.round(rate)}%`;
}
