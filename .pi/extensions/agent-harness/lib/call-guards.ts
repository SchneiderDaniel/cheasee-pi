// ── Blocking guards ─────────────────────────────────────────────
// The guards that can turn a tool call into a block, evaluated in the harness's
// documented order: retry-after-error, read cache, same-tool cascade, and the
// bash tool-mismatch redirects. Split out of agent-harness.ts (issue #2033) so
// the class keeps only the state machine and the recording rules.

import { isBashFileRead, isBashSearch } from "../../lib/bash-query.ts";
import { buildRedirectMessage, shouldBlockRetry } from "./harness-rules.ts";
import type { HarnessState } from "./harness-state.ts";
import type { ToolCallResult } from "./harness-types.ts";
import type { ToolMeta } from "./harness-rules.ts";

export interface GuardInput {
	toolName: string;
	/** The raw `bash` command string, "" for other tools. */
	bashCommand: string;
	args: Record<string, unknown>;
	sessionTurn: number;
	isError: boolean | undefined;
	hasUI: boolean;
	meta: ToolMeta;
	cascadeThreshold: number;
}

/**
 * Steps 3/4 — error retry and read cache. Only runs for non-error events.
 *
 * Retry: block once the same tool has errored `shouldBlockRetry` times.
 * Cache: a read of the same path|offset|limit from an earlier turn is blocked
 * with the caching turn, so the model pages instead of re-reading.
 */
export function resolveRetryOrCache(state: HarnessState, input: GuardInput): ToolCallResult | null {
	if (input.isError) return null;

	// ── 3. Error retry blocking ──
	const errors = state.errorTracker.getLastErrors(input.toolName);
	if (shouldBlockRetry(errors.length)) {
		const lastErrorTurn = errors[errors.length - 1]?.turn ?? 0;
		return {
			block: true,
			reason: `Tool ${input.toolName} errored ${errors.length}x (last turn ${lastErrorTurn}). Try a different approach or tool instead of retrying.`,
		};
	}

	// ── 4. Read caching (boolean-existence tracking with sessionTurn TTL) ──
	if (input.toolName !== "read") return null;
	const path = (input.args.path ?? "") as string;
	if (!path) return null;

	const offset = (input.args.offset ?? 0) as number;
	const limit = (input.args.limit ?? "") as number;
	const cacheKey = `${path}|${offset}|${limit}`;
	const cached = state.readCache.get(cacheKey, input.sessionTurn);
	if (!cached) {
		// Store existence marker to track that this path+offset+limit was recently read
		state.readCache.set(cacheKey, input.sessionTurn);
		return null;
	}
	// Same-turn → pass through (let re-read happen in same turn).
	// Non-TUI mode → bypass the cache block.
	if (cached.turn === input.sessionTurn) return null;
	if (!input.hasUI) return null;
	return {
		block: true,
		reason: `Content cached from turn ${cached.turn} — use offset/limit to page or re-read after 6 turns.`,
	};
}

/**
 * Step 5 — same-tool cascade. The count is read BEFORE recording, +1 for the
 * current call, so a blocked call never inflates the counter.
 */
export function resolveCascadeBlock(
	state: HarnessState,
	input: GuardInput,
	bashSubKey: string | undefined,
	suggestion: string,
): ToolCallResult | null {
	const consecutive = state.callCounter.getConsecutive(input.toolName, bashSubKey);
	const effectiveCount = consecutive.count + 1;
	if (effectiveCount < input.cascadeThreshold) return null;
	return {
		block: true,
		reason: `Same-tool cascade: ${input.toolName} called ${effectiveCount}x consecutively. ${suggestion}.`,
	};
}

/**
 * Step 6 — bash tool mismatch: searching in bash redirects to
 * `ripgrep_search`, reading a file in bash redirects to `read`. `ls` stays
 * informational and is never blocked.
 */
export function resolveRedirectBlock(bashCommand: string): ToolCallResult | null {
	if (isBashSearch(bashCommand)) {
		return {
			block: true,
			reason: buildRedirectMessage("ripgrep_search"),
			redirectTo: "ripgrep_search",
		};
	}
	if (isBashFileRead(bashCommand)) {
		return {
			block: true,
			reason: buildRedirectMessage("read"),
			redirectTo: "read",
		};
	}
	return null;
}
