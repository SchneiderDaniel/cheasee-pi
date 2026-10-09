// ─── Size tier: test-plan issue size → timeout scale (issue #1987) ──
// Pure text classification. The test-designer mandates a `**Tier:**`
// marker in its Test Plan comment (agents/test-designer.md), so the size
// signal is already in hand at dispatch. The tier scales the default
// per-agent wall-clock timeout so large issues are not killed mid-work.

/** Declared issue size, from the Test Plan comment's `**Tier:**` marker. */
export type SizeTier = "small" | "medium" | "large";

/** Built-in timeout multiplier per tier; `agentTimeoutTierScale` overrides per key. */
export const DEFAULT_TIER_SCALE: Record<SizeTier, number> = { small: 1, medium: 1.5, large: 2 };

const TIER_MARKER_RE = /\*\*Tier:\*\*\s*(small|medium|large)\b/i;
const TEST_PLAN_HEADING_RE = /##\s*Test\s*Plan/i;

/**
 * Classify issue size from the declared tier marker. A comment carrying the
 * `## Test Plan` heading wins over an earlier comment that merely quotes the
 * marker; with no Test Plan heading the first marker in comment order wins.
 * Unknown/absent marker → null (caller keeps the unscaled default).
 */
export function parseSizeTier(comments: Array<{ body?: string | null }>): SizeTier | null {
	let fallback: SizeTier | null = null;
	for (const comment of comments) {
		const body = comment?.body;
		if (typeof body !== "string") continue;
		const match = body.match(TIER_MARKER_RE);
		if (!match?.[1]) continue;
		const tier = match[1].toLowerCase() as SizeTier;
		if (TEST_PLAN_HEADING_RE.test(body)) return tier;
		if (fallback === null) fallback = tier;
	}
	return fallback;
}
