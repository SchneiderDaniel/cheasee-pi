/**
 * renderer/format.ts — Markdown formatting primitives for session reports.
 *
 * Pure functions, no I/O. Moved verbatim from renderer.ts — the escaping
 * rules (escMd pipes/backticks) are GFM-table-critical, so any change here
 * alters rendered output (golden-characterized).
 */

export const TRUNCATE_RESULT_LINES = 8;
export const THINKING_PREVIEW_CHARS = 120;

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return String(n);
}

export function fmtCost(c: number | undefined | null): string {
	if (c == null || c === 0) return "$0";
	if (c < 0.001) return `$${c.toFixed(6)}`;
	if (c < 1) return `$${c.toFixed(4)}`;
	return `$${c.toFixed(2)}`;
}

export function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n) + `…(+${s.length - n} chars)`;
}

export function resultPreview(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= TRUNCATE_RESULT_LINES && text.length <= 500) return text;
	return (
		lines.slice(0, TRUNCATE_RESULT_LINES).join("\n") +
		`\n…(+${lines.length - TRUNCATE_RESULT_LINES} more lines, ${text.length} total chars)`
	);
}

export function escMd(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/`/g, "\\`");
}

/** Format duration from milliseconds to human-readable string. */
export function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
	const min = Math.floor(ms / 60000);
	const sec = Math.round((ms % 60000) / 1000);
	return `${min}m ${sec}s`;
}
