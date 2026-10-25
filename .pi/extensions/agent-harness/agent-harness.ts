/**
 * agent-harness — Runtime Tool Call Validation Extension
 *
 * AgentHarness class encapsulates the tool call guard logic and harness state.
 * State is private — the only public methods are handleToolCall() and reset().
 * Internal factory createHarnessState() provides fresh state in the constructor.
 *
 * Guard order:
 *  0.5 Nested attribution → roll up to the parent tool, never blocked
 *  1. Pass-through tools → always pass, record for cascade reset
 *  2. Error tracking → push to tracker, pass through
 *  2.5 Cache invalidation → write/file-modifying bash clears read cache
 *  3. Error retry blocking → if >=2 errors, block
 *  4. Read caching → cache hit blocks with cached info
 *  5. Cascade detection → consecutive blocks (8+ legit calls)
 *  6. Tool mismatch (bash) → block with redirect
 *  7. Record if not blocked (blocked calls don't inflate cascade counter)
 *
 * Split by responsibility (issue #2033): sub-key derivation in
 * lib/bash-subkey.ts, metadata lookup in lib/tool-meta.ts, call bookkeeping in
 * lib/tool-call-state.ts, the guard pipeline in lib/tool-call-pipeline.ts, the
 * event/result types in lib/harness-types.ts. This module keeps the
 * interception state machine and the public methods; the moved names are
 * re-exported here so importers are untouched.
 *
 * @packageDocumentation
 */

import { createHarnessState } from "./lib/harness-state.ts";
import type { HarnessState } from "./lib/harness-state.ts";
import { loadDefaultRules } from "./lib/harness-rules.ts";
import { createToolMetaLookup } from "./lib/tool-meta.ts";
import { normalizeCall, runGuards } from "./lib/tool-call-pipeline.ts";
import { attributeNestedCall, indexCallId } from "./lib/tool-call-state.ts";
import type { ResolvedHarnessRules, ToolMeta } from "./lib/harness-rules.ts";
import type {
	ToolCallContext,
	ToolCallEvent,
	ToolCallResult,
	ToolInfoProvider,
} from "./lib/harness-types.ts";

// ── Types ──

export type { ToolCallContext, ToolCallEvent, ToolCallResult, ToolInfoProvider };
export type { ResolvedHarnessRules } from "./lib/harness-rules.ts";
export { getBashSubKey } from "./lib/bash-subkey.ts";

// ── AgentHarness Class ──

/**
 * AgentHarness — Runtime tool call validation with private state.
 *
 * Construct with `new AgentHarness()` to get a fresh harness.
 * Call `handleToolCall(event, ctx)` to validate each tool call.
 * Call `handleTurnStart()` on each turn boundary (resets cascade, decays errors).
 * Call `reset()` to create fresh state (new session).
 */
export class AgentHarness {
	private state: HarnessState;
	/** True when there is an interactive user (set per handleToolCall invocation). */
	#hasUI: boolean = true;
	/** Resolved harness rules (defaults or merged with project config). */
	#resolvedRules: ResolvedHarnessRules;
	/** Lazily-consulted tool-info port (annotations source). */
	#toolInfoProvider?: ToolInfoProvider;
	/** Metadata resolution: config > annotations > default, with its warning flag. */
	#meta: ReturnType<typeof createToolMetaLookup>;

	constructor(rules?: ResolvedHarnessRules) {
		this.state = createHarnessState();
		this.#resolvedRules = rules ?? loadDefaultRules();
		this.#meta = createToolMetaLookup({
			rules: () => this.#resolvedRules,
			provider: () => this.#toolInfoProvider,
		});
	}

	/**
	 * Set resolved harness rules (called on session_start after config loading).
	 */
	setRules(rules: ResolvedHarnessRules): void {
		this.#resolvedRules = rules;
	}

	/**
	 * Inject the tool-info port (called on session_start). Resolved lazily —
	 * no snapshot is taken here.
	 */
	setToolInfoProvider(provider?: ToolInfoProvider): void {
		this.#toolInfoProvider = provider;
		this.#meta.resetWarning();
	}

	/** Resolve the effective ToolMeta for a tool. */
	#getToolMeta(toolName: string): ToolMeta {
		return this.#meta.get(toolName);
	}

	/**
	 * Validate a tool call against all guards.
	 * Returns null (pass-through) or ToolCallResult (block).
	 *
	 * Guard order:
	 *  0.5 Nested attribution → nested calls roll up to parent, never blocked
	 *  1. Pass-through tools → always pass, record for cascade reset
	 *  2. Error tracking → push to tracker (unless trackErrors:false), pass through
	 *  2.5 Cache invalidation → write/file-modifying bash clears read cache
	 *  3. Error retry blocking → if >=2 errors, block
	 *  4. Read caching → cache hit blocks with cached info
	 *  5. Cascade detection → consecutive blocks (8+ legit calls)
	 *  6. Tool mismatch (bash) → block with redirect
	 *  7. Record if not blocked (blocked calls don't inflate cascade counter)
	 */
	handleToolCall(event: ToolCallEvent, _ctx: ToolCallContext): ToolCallResult | null {
		const toolCallIndex = this.state.toolCallIndex;
		const sessionTurn = this.state.sessionTurn;
		const toolCallId = event.toolCallId;
		const parentToolCallId = event.parentToolCallId;

		// ── Extract hasUI from context (backward-compatible cast) ──
		this.#hasUI = (_ctx as any).hasUI !== false;

		const { toolName, args, bashCommand, bashSubKey, force } = normalizeCall(event);

		// ── Guard: undefined/empty toolName → skip recording, pass through ──
		if (!toolName) {
			this.state.toolCallIndex++;
			return null;
		}

		if (toolCallId) {
			indexCallId(this.state, {
				toolCallId,
				parentToolCallId,
				toolName,
				bashSubKey,
				sessionTurn,
			});
		}

		// ── Step 0.5: Nested-call attribution ──
		// ctx.executeTool()-issued calls carry parentToolCallId. They never run
		// Steps 1/3–6: a nested block would break the parent tool, not teach the
		// model. They only roll up to the parent and still invalidate the cache.
		if (parentToolCallId) {
			attributeNestedCall(this.state, event, args, toolName, parentToolCallId, sessionTurn, (t) =>
				this.#getToolMeta(t),
			);
			this.state.toolCallIndex++;
			return null;
		}

		const meta = this.#getToolMeta(toolName);
		const result = runGuards(
			this.state,
			{
				toolName,
				args,
				bashCommand,
				bashSubKey,
				sessionTurn,
				toolCallIndex,
				isError: event.isError,
				force,
			},
			{
				hasUI: this.#hasUI,
				meta,
				cascadeThreshold: meta.cascadeThreshold ?? this.#resolvedRules.cascadeThreshold,
			},
		);

		// ── 8. Increment toolCallIndex for every code path, return result ──
		this.state.toolCallIndex++;

		return result;
	}

	/**
	 * Handle turn boundary event.
	 * Increments sessionTurn, resets cascade counter, decays error tracker.
	 * Called by the extension's turn_start handler.
	 */
	handleTurnStart(): void {
		this.state.sessionTurn++;
		this.state.callCounter.turnBoundaryReset();
		this.state.errorTracker.decay();
	}

	/**
	 * Reset harness state for a new session.
	 * Creates a completely fresh state — all caches, counters, and trackers cleared.
	 */
	reset(): void {
		this.state = createHarnessState();
	}
}
