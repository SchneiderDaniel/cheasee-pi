// ── Guard pipeline ──────────────────────────────────────────────
// The ordered guards a non-nested tool call runs through, plus the recording
// rules (blocked calls are never recorded; pass-through and bypassed calls are).
// Split out of agent-harness.ts (issue #2033): the class keeps the state
// machine, this keeps the decisions.

import { hasBypassAnnotation } from "../../lib/bash-query.ts";
import { cascadeSuggestion } from "./batch-advice.ts";
import { resolveCascadeBlock, resolveRedirectBlock, resolveRetryOrCache } from "./call-guards.ts";
import type { HarnessState } from "./harness-state.ts";
import type { ToolCallEvent, ToolCallResult } from "./harness-types.ts";
import type { ToolMeta } from "./harness-rules.ts";
import { invalidateReadCache } from "./tool-call-state.ts";
import { getBashSubKey } from "./bash-subkey.ts";

export interface GuardCall {
	toolName: string;
	args: Record<string, unknown>;
	/** The raw `bash` command string, "" for other tools. */
	bashCommand: string;
	bashSubKey: string | undefined;
	sessionTurn: number;
	toolCallIndex: number;
	isError: boolean | undefined;
	/** `_harness.force` from the reserved field, undefined when absent. */
	force: boolean | undefined;
}

export interface NormalizedCall {
	toolName: string | undefined;
	args: Record<string, unknown>;
	/** The raw `bash` command string, "" for other tools. */
	bashCommand: string;
	bashSubKey: string | undefined;
	/** `_harness.force` from the reserved field, undefined when absent. */
	force: boolean | undefined;
}

/**
 * Read a tool-call event: default the args object, consume and strip the
 * reserved `_harness` field, and derive the bash command + its cascade sub-key.
 */
export function normalizeCall(event: ToolCallEvent): NormalizedCall {
	const args = event.input ?? {};

	// ── Reserved `_harness` field is consumed and stripped before any branch ──
	const forceField = args._harness as { force?: boolean } | undefined;
	if (args._harness !== undefined) {
		delete (event.input as Record<string, unknown>)._harness;
	}

	const toolName = event.toolName;
	// Extract bash command string for classification (bypass gate and later guards)
	const bashCommand = (toolName === "bash" ? (args.command ?? "") : "") as string;
	const bashSubKey =
		toolName === "bash" ? getBashSubKey((args.command ?? "") as string) : undefined;

	return { toolName, args, bashCommand, bashSubKey, force: forceField?.force };
}

export interface GuardOptions {
	hasUI: boolean;
	meta: ToolMeta;
	cascadeThreshold: number;
}

/**
 * Run steps 0–7 and record the call when it is not blocked.
 * Nested calls (step 0.5) never reach this function.
 */
export function runGuards(
	state: HarnessState,
	call: GuardCall,
	opts: GuardOptions,
): ToolCallResult | null {
	const { toolName, args, bashCommand, bashSubKey, sessionTurn, toolCallIndex } = call;

	// ── Step 0: Force-bypass gate ──
	// Per-call escape hatch: _harness.force: true or # bypass-harness comment
	// annotation. Requires hasUI: true (deliberate intent — prevents
	// headless/automated abuse). Force-bypassed calls are recorded as real calls
	// (they count toward cascade).
	const forceBypass = call.force === true;
	const bypassAnnotation = toolName === "bash" && hasBypassAnnotation(bashCommand);
	if ((forceBypass || bypassAnnotation) && opts.hasUI) {
		state.callCounter.record(toolName, sessionTurn, toolCallIndex, bashSubKey);
		return null;
	}

	// ── 1. Pass-through tools → always pass, but record for cascade reset ──
	if (opts.meta.passThrough) {
		state.callCounter.record(toolName, sessionTurn, toolCallIndex);
		return null;
	}

	// ── 2. Error tracking (gated on trackErrors — read-only tools are exempt) ──
	// Record the session turn (not toolCallIndex) so the block message's
	// "last turn N" names the same unit the read-cache message uses.
	if (call.isError && opts.meta.trackErrors !== false) {
		state.errorTracker.push(toolName, { turn: sessionTurn, toolName });
	}

	// ── 2.5 Cache invalidation (before blocking guards) ──
	invalidateReadCache(state, toolName, bashCommand);

	const guardInput = {
		toolName,
		bashCommand,
		args,
		sessionTurn,
		isError: call.isError,
		hasUI: opts.hasUI,
		meta: opts.meta,
		cascadeThreshold: opts.cascadeThreshold,
	};

	// ── 3/4. Error retry & read cache blocking ──
	let result = resolveRetryOrCache(state, guardInput);

	// ── 5. Same-tool cascade detection (skip read — cache handles redundant reads) ──
	if (!result && toolName !== "read") {
		const suggestion = cascadeSuggestion(toolName, (args.command ?? "") as string);
		result = resolveCascadeBlock(state, guardInput, bashSubKey, suggestion);
	}

	// ── 6. Tool mismatch detection (bash only) ──
	if (!result && bashCommand) {
		result = resolveRedirectBlock(bashCommand);
	}

	// ── 7. Record only if NOT blocked ──
	// Blocked calls (any guard) are NOT recorded so they don't inflate the
	// cascade counter.
	if (!result) {
		state.callCounter.record(toolName, sessionTurn, toolCallIndex, bashSubKey);
	}

	return result;
}
