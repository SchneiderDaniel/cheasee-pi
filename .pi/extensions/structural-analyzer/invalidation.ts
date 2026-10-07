/**
 * invalidation.ts — cache-invalidation policy for structural-analyzer.
 *
 * Owns the single volatile fact: which tool results mean "the code on disk
 * may have changed". Registered once by the extension entry point; nothing
 * else calls clearResultCache ad hoc.
 *
 * Deliberate gap: `bash` is not treated as mutating (sed -i, rm, git checkout,
 * codegen all live there). Blanket invalidation on every bash would destroy
 * cache value in the normal agent loop, and a command-name heuristic is
 * brittler than the write/edit signal. `isMutatingToolResult` is the single
 * extension point if that trade-off changes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearResultCache } from "./cache.ts";

/**
 * Tool names whose successful completion may change files on disk.
 * `multiedit` is absent until pi ships it — add it here when it does.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * True when a tool result indicates the filesystem may have changed.
 * Failed mutations (`isError`) do not invalidate — the disk is unchanged, and
 * invalidating would punish error-retry loops.
 */
export function isMutatingToolResult(event: { toolName?: string; isError?: boolean }): boolean {
	if (event.isError) return false;
	return event.toolName !== undefined && MUTATING_TOOL_NAMES.has(event.toolName);
}

/**
 * Register the cache-invalidation handlers. Call once from the extension entry
 * point, replacing any standalone `session_shutdown` handler.
 *
 * - `tool_result`: a successful write/edit clears the cache before the next search.
 * - `session_start`: clear on process reuse so entries never bleed across sessions.
 */
export function registerCacheInvalidation(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event) => {
		if (isMutatingToolResult(event)) {
			clearResultCache();
		}
	});

	pi.on("session_start", async () => {
		clearResultCache();
	});
}
