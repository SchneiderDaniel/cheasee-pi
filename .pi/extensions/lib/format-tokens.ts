/**
 * format-tokens.ts — Canonical token-count → display-string formatters.
 *
 * Domain layer — zero dependencies (no pi runtime, no agent-harness).
 * Pure functions with no I/O.
 *
 * Single source of truth for all extensions: two separate formatters for two
 * display conventions. Do not fold them behind a flag — they differ in output
 * by design (uppercase/1-decimal vs lowercase/0-decimal).
 */

/** Verbose display: 1234567 → "1.2M"; 1500 → "1.5K"; 42 → "42". */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Integer-rounded, lowercase k/m display for compact stats lines.
 *  Values <1000 return raw number; values >=1e6 use lowercase `m`.
 */
export function formatTokensInt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}m`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}
