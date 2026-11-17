/**
 * Cache hit-rate policy for the context-info footer (issue #2136).
 *
 * Pure: no pi, no TUI, no formatting. The footer renderer displays whatever
 * this returns; event handlers only forward the provider usage record.
 *
 * ── Why the denominator includes `input` ────────────────────────
 * The metric answers "of the prompt tokens the provider actually accounted
 * for, how many came out of the cache?":
 *
 *     cacheRead / (input + cacheRead + cacheWrite) * 100
 *
 * The previous formula — `cacheRead / (cacheRead + cacheWrite)` — only
 * compared the two cache buckets with each other. Whenever a provider reported
 * `cacheWrite === 0` (the common warm-cache case) that formula returned 100%
 * even though the bulk of the prompt was a plain, uncached read. Including
 * `input` gives a denominator that cannot be saturated by a zero write bucket.
 *
 * `pi-ai` sets `Usage.input = promptTokens - cacheRead`, i.e. `input` excludes
 * cached tokens, so the three fields are disjoint and their sum is the prompt
 * token total the provider is willing to account for. 100% is therefore only
 * reachable when `input` is 0 — a fully cached prompt.
 *
 * The result is the *read share of reported prompt tokens*, not a guarantee
 * that every cache-eligible token was a hit; providers do not expose enough
 * information to make that claim, which is why the footer labels the value
 * "Cache Hit Rate" on top of the explicit read/write counts.
 */

/** The slice of `pi-ai`'s `Usage` this policy reads. Fields are untrusted. */
export interface CacheUsage {
	input?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
}

/**
 * Cache hit rate as a percentage of reported prompt tokens, or `undefined`
 * when the record cannot support a rate (missing field, non-finite value,
 * negative count, or a zero denominator).
 *
 * Unrounded on purpose: the display layer rounds, and keeping the exact value
 * in `FooterConfig.cacheHitRate` avoids compounding rounding across renders.
 */
export function computeCacheHitRate(usage: CacheUsage | null | undefined): number | undefined {
	if (usage === null || usage === undefined || typeof usage !== "object") return undefined;

	const input = readCount(usage.input);
	const cacheRead = readCount(usage.cacheRead);
	const cacheWrite = readCount(usage.cacheWrite);
	if (input === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;

	const denominator = input + cacheRead + cacheWrite;
	if (denominator <= 0) return undefined;

	return (cacheRead / denominator) * 100;
}

/** Accept only finite, non-negative token counts. Anything else is unusable. */
function readCount(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value)) return undefined;
	if (value < 0) return undefined;
	return value;
}
