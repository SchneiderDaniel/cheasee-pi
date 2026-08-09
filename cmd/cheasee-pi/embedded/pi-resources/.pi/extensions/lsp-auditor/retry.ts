/**
 * Retry logic for LSP Auditor.
 *
 * Pure logic — zero I/O. Tracks how many retry attempts have been made
 * for a given issue and whether another retry should be allowed.
 */

// ─── Constants ───────────────────────────────────────────────────────

/** Maximum retry attempts before forcing through to Auditor. */
export const MAX_RETRIES = 3;

/** Session entry type for retry tracking. */
export const RETRY_ENTRY_TYPE = "lsp-audit-retry";

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Count how many LSP audit retries have been attempted for a given issue.
 */
export function countRetryAttempts(
	entries: Array<{ type: string; payload: unknown }>,
	issueNum: number,
): number {
	if (!entries || !Array.isArray(entries)) return 0;
	let count = 0;
	for (const entry of entries) {
		if (entry.type !== RETRY_ENTRY_TYPE) continue;
		const payload = entry.payload as Record<string, unknown> | undefined;
		if (payload?.issueNum === issueNum) count++;
	}
	return count;
}

/**
 * Should we retry (keep in Implementation) or proceed to Audit?
 */
export function shouldRetry(attempts: number): boolean {
	const n = typeof attempts !== "number" || Number.isNaN(attempts) || attempts < 0 ? 0 : attempts;
	return n < MAX_RETRIES;
}
