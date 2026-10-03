/**
 * Active-branch retry-budget adapter.
 *
 * Retry budgets must be branch-local: session entries include abandoned
 * sibling branches, so counting them would let phantom retries exhaust the
 * active branch's budget. This module owns the session-manager read;
 * retry.ts stays pure (no I/O).
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { countRetryAttempts } from "./retry.ts";

/**
 * Map session-storage entries to retry-logic shape.
 *
 * Session entries from `appendEntry()` have shape:
 *   { type: "custom", customType: "<type>", data: <payload> }
 * Retry logic expects:  { type: "<type>", payload: <payload> }
 *
 * Non-custom entries pass through with the full entry as payload.
 */
export function mapSessionEntriesToRetryEntries(
	entries: Array<Record<string, unknown>>,
): Array<{ type: string; payload: unknown }> {
	return entries.map((e) => {
		if (e.type === "custom") {
			return { type: (e.customType as string) ?? "", payload: e.data };
		}
		return { type: e.type as string, payload: e };
	});
}

/**
 * Count retry attempts recorded on the active branch's lineage only.
 *
 * `getBranch()` walks the active leaf's parent links, so pre-fork ancestors
 * remain counted (shared lineage) while abandoned sibling branches are
 * excluded. Defensive against a null/undefined leaf (`getBranch()` returns
 * `[]`) and a missing session-manager method.
 */
export function countBranchRetryAttempts(
	sm: Pick<SessionManager, "getBranch"> | null | undefined,
	issueNum: number,
): number {
	const branch = (sm?.getBranch?.() ?? []) as unknown as Array<Record<string, unknown>>;
	return countRetryAttempts(mapSessionEntriesToRetryEntries(branch), issueNum);
}
