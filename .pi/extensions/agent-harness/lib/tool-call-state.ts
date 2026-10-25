// ── Call bookkeeping ────────────────────────────────────────────
// What the harness records about a call: the read-cache invalidation, the
// call-id index that lets a nested call roll up to its parent, and the nested
// attribution itself. Split out of agent-harness.ts (issue #2033).

import { isBashFileModify } from "../../lib/bash-query.ts";
import type { HarnessState } from "./harness-state.ts";
import type { ToolCallEvent } from "./harness-types.ts";
import type { ToolMeta } from "./harness-rules.ts";

/** Step 2.5 — file-modifying tool calls invalidate the read cache. */
export function invalidateReadCache(
	state: HarnessState,
	toolName: string,
	bashCommand: string,
): void {
	if (toolName === "write" || toolName === "edit") {
		state.readCache.clear();
	} else if (bashCommand && isBashFileModify(bashCommand)) {
		state.readCache.clear();
	}
}

/**
 * Index this call id → its composite counter identity (tool + bash sub-key) so
 * nested calls roll up to the exact parent entry. For a nested call we propagate
 * the parent's already-resolved identity instead, so a grandchild (depth ≥2)
 * still rolls up to the root parent rather than to a counter entry under the
 * nested tool (which is never recorded). An unmapped parent is left unindexed →
 * its descendants stay uncounted.
 */
export function indexCallId(
	state: HarnessState,
	call: {
		toolCallId: string;
		parentToolCallId: string | undefined;
		toolName: string;
		bashSubKey: string | undefined;
		sessionTurn: number;
	},
): void {
	const { toolCallId, parentToolCallId, toolName, bashSubKey, sessionTurn } = call;
	if (parentToolCallId) {
		const parentIdentity = state.callIdIndex.get(parentToolCallId, sessionTurn);
		if (parentIdentity) {
			state.callIdIndex.set(toolCallId, parentIdentity, sessionTurn);
		}
		return;
	}
	state.callIdIndex.set(toolCallId, { toolName, subKey: bashSubKey }, sessionTurn);
}

/**
 * Attribute a nested call (`ctx.executeTool`-issued) to its parent tool.
 * Nested calls are never blocked: the parent tool sees the nested result and a
 * block here would break the parent rather than teach the model. They only roll
 * their count (and errors) up to the parent's composite counter identity
 * (tool + bash sub-key, captured in the call-id index) and still run cache
 * invalidation. Unmapped parents (state reset / foreign instance) are ignored.
 */
export function attributeNestedCall(
	state: HarnessState,
	event: ToolCallEvent,
	args: Record<string, unknown>,
	toolName: string,
	parentToolCallId: string,
	sessionTurn: number,
	metaFor: (toolName: string) => ToolMeta,
): void {
	// Step 2.5 still applies to nested calls.
	invalidateReadCache(state, toolName, (args.command ?? "") as string);

	const parent = state.callIdIndex.get(parentToolCallId, sessionTurn);
	if (!parent) return;

	state.callCounter.recordNested(parent, sessionTurn);
	// Apply the parent's effective trackErrors setting — a read-only parent must
	// not be error-blocked by nested failures (config still wins).
	if (event.isError && metaFor(parent.toolName).trackErrors !== false) {
		state.errorTracker.push(parent.toolName, { turn: sessionTurn, toolName });
	}
}
