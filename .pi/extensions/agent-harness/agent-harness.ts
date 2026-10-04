/**
 * agent-harness — Runtime Tool Call Validation Extension
 *
 * AgentHarness class encapsulates the tool call guard logic and harness state.
 * State is private — the only public methods are handleToolCall() and reset().
 * Internal factory createHarnessState() provides fresh state in the constructor.
 *
 * Guard order:
 *  1. Pass-through tools → always pass, record for cascade reset
 *  2. Error tracking → push to tracker, pass through
 *  2.5 Cache invalidation → write/file-modifying bash clears read cache
 *  3. Error retry blocking → if >=2 errors, block
 *  4. Read caching → cache hit blocks with cached info
 *  5. Cascade detection → consecutive blocks (8+ legit calls)
 *  6. Tool mismatch (bash) → block with redirect
 *  7. Record if not blocked (blocked calls don't inflate cascade counter)
 *
 * @packageDocumentation
 */

import { createHarnessState } from "./lib/harness-state.ts";
import type { HarnessState } from "./lib/harness-state.ts";
import {
	buildRedirectMessage,
	MULTI_VERB_TOOLS,
	loadDefaultRules,
	shouldBlockRetry,
} from "./lib/harness-rules.ts";
import {
	deriveToolMetaFromAnnotations,
} from "./lib/tool-annotations.ts";
import type { ToolInfoLike } from "./lib/tool-annotations.ts";
import {
	hasBypassAnnotation,
	isBashSearch,
	isBashFileRead,
	isBashFileModify,
} from "../lib/bash-query.ts";
import type { ResolvedHarnessRules, ToolMeta } from "./lib/harness-rules.ts";

// ── Types ──

export interface ToolCallResult {
	block: boolean;
	reason: string;
	redirectTo?: string;
}

/**
 * Port for tool metadata. The pi adapter (index.ts) supplies a closure over
 * `pi.getAllTools()`; the harness stays pi-free. Resolved lazily on every
 * `tool_call` so later-registered tools are visible without a session snapshot.
 */
export type ToolInfoProvider = () => ReadonlyArray<ToolInfoLike>;

interface ToolCallEvent {
	toolName?: string;
	input: Record<string, unknown>;
	isError?: boolean;
	toolCallId?: string;
	parentToolCallId?: string;
}

interface ToolCallContext {
	sessionManager?: {
		getCwd?: () => string;
	};
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
	/** Context mode: "tui", "rpc", "json", "print", etc. */
	mode?: string;
	/** True if there is an interactive user to respond to prompts. */
	hasUI?: boolean;
	/** Check if the current project is trusted. Returns false when undefined. */
	isProjectTrusted?: () => boolean;
}

// ── Helpers ──

export type { ResolvedHarnessRules } from "./lib/harness-rules.ts";

/**
 * Extract bash sub-key for sub-command-aware cascade detection.
 * Multi-verb CLIs (git, npm, docker, gh, etc.) use first 2 tokens.
 * Single-verb commands (cat, echo, ls, etc.) use first token only.
 * Empty → undefined.
 */
export function getBashSubKey(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;

	const tokens = trimmed.split(/\s+/);
	if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "")) return undefined;

	// Determine which tokens form the sub-command
	// If command starts with cd <path> &&, strip navigation prefix
	let subKeyTokens: string[];
	if (tokens[0] === "cd") {
		const andAndIndex = tokens.indexOf("&&");
		if (andAndIndex > 0) {
			// Extract subKey from tokens after && (the real command)
			subKeyTokens = tokens.slice(andAndIndex + 1);
		} else {
			// Bare cd (no &&) — cd IS the command
			subKeyTokens = tokens;
		}
	} else {
		subKeyTokens = tokens;
	}

	if (subKeyTokens.length === 0) return undefined;

	if (MULTI_VERB_TOOLS.has(subKeyTokens[0]) && subKeyTokens.length > 1) {
		return `${subKeyTokens[0]} ${subKeyTokens[1]}`;
	}

	return subKeyTokens[0];
}

// ── Batch advice table for same-tool cascade suggestions ──

const BATCH_ADVICE: Record<string, string | ((cmd: string) => string)> = {
	bash: (cmd: string) =>
		cmd.includes("&&")
			? "Reduce per-turn call count — commands already use && for batching"
			: "Combine bash calls with && or use a script file",
	read: "Batch reads — read larger portions in one call",
};

const defaultAdvice = (t: string) => `Batch ${t} calls to reduce turns`;

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
	/** True once the fail-open annotation-lookup warning has been surfaced. */
	#annotationWarningEmitted = false;

	constructor(rules?: ResolvedHarnessRules) {
		this.state = createHarnessState();
		this.#resolvedRules = rules ?? loadDefaultRules();
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
		this.#annotationWarningEmitted = false;
	}

	/**
	 * Resolve the effective ToolMeta for a tool.
	 *
	 * Precedence: explicit config `toolMeta` > hardcoded `TOOL_META` >
	 * annotation-derived > generic default.
	 */
	#getToolMeta(toolName: string): ToolMeta {
		const explicit = this.#resolvedRules.toolMeta[toolName];
		if (explicit) return explicit;

		const derived = this.#getDerivedToolMeta(toolName);
		if (derived) return derived;

		return {
			passThrough: false,
			trackErrors: true,
			cascadeThreshold: this.#resolvedRules.cascadeThreshold,
		};
	}

	/**
	 * Look up annotations via the injected port. Fail-open: a throwing provider
	 * must never convert into a fail-closed block (pi treats a `tool_call`
	 * handler throw as a block). Surfaced once, then silently ignored.
	 */
	#getDerivedToolMeta(toolName: string): ToolMeta | undefined {
		const provider = this.#toolInfoProvider;
		if (!provider) return undefined;
		try {
			const info = provider().find((t) => t.name === toolName);
			if (!info) return undefined;
			return deriveToolMetaFromAnnotations(info.annotations);
		} catch (e) {
			if (!this.#annotationWarningEmitted) {
				this.#annotationWarningEmitted = true;
				console.error(
					`agent-harness: tool annotation lookup failed — using default rules (${(e as Error).message})`,
				);
			}
			return undefined;
		}
	}

	/**
	 * Attribute a nested call (`ctx.executeTool`-issued) to its parent tool.
	 * Nested calls are never blocked: the parent tool sees the nested result and
	 * a block here would break the parent rather than teach the model. They only
	 * roll their count (and errors) up to the parent, and still run cache
	 * invalidation. Unmapped parents (state reset / foreign instance) are ignored.
	 */
	#attributeNestedCall(
		event: ToolCallEvent,
		args: Record<string, unknown>,
		toolName: string,
		parentToolCallId: string,
		sessionTurn: number,
	): void {
		// Step 2.5 still applies to nested calls.
		if (toolName === "write" || toolName === "edit") {
			this.state.readCache.clear();
		} else if (toolName === "bash") {
			const command = (args.command ?? "") as string;
			if (command && isBashFileModify(command)) {
				this.state.readCache.clear();
			}
		}

		const parentToolName = this.state.callIdIndex.get(parentToolCallId, sessionTurn);
		if (!parentToolName) return;

		this.state.callCounter.recordNested(parentToolName, sessionTurn);
		// Apply the parent's effective trackErrors setting — a read-only parent
		// must not be error-blocked by nested failures (config still wins).
		if (event.isError && this.#getToolMeta(parentToolName).trackErrors !== false) {
			this.state.errorTracker.push(parentToolName, { turn: sessionTurn, toolName });
		}
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
		const toolName = event.toolName;
		const args = event.input ?? {};
		const toolCallIndex = this.state.toolCallIndex;
		const sessionTurn = this.state.sessionTurn;
		const toolCallId = event.toolCallId;
		const parentToolCallId = event.parentToolCallId;

		// ── Extract hasUI from context (backward-compatible cast) ──
		this.#hasUI = (_ctx as any).hasUI !== false;

		// ── Reserved `_harness` field is consumed and stripped before any branch ──
		const forceField = args._harness as { force?: boolean } | undefined;
		if (args._harness !== undefined) {
			delete (event.input as Record<string, unknown>)._harness;
		}

		// ── Guard: undefined/empty toolName → skip recording, pass through ──
		if (!toolName) {
			this.state.toolCallIndex++;
			return null;
		}

		// ── Index this call id so nested calls can resolve their parent tool name ──
		// Also handles depth ≥2: a nested call's own synthetic id may itself be a parent.
		if (toolCallId) {
			this.state.callIdIndex.set(toolCallId, toolName, sessionTurn);
		}

		// ── Step 0.5: Nested-call attribution ──
		// ctx.executeTool()-issued calls carry parentToolCallId. They never run
		// Steps 1/3–6: a nested block would break the parent tool, not teach the
		// model. They only roll up to the parent and still invalidate the cache.
		if (parentToolCallId) {
			this.#attributeNestedCall(event, args, toolName, parentToolCallId, sessionTurn);
			this.state.toolCallIndex++;
			return null;
		}

		// Extract bash command string for classification (used by bypass gate and later guards)
		const bashCommand = (toolName === "bash" ? (args.command ?? "") : "") as string;
		const bashSubKey =
			toolName === "bash" ? getBashSubKey((args.command ?? "") as string) : undefined;

		// ── Step 0: Force-bypass gate ──
		// Per-call escape hatch: _harness.force: true or # bypass-harness comment annotation.
		// Requires hasUI: true (deliberate intent — prevents headless/automated abuse).
		// Force-bypassed calls are recorded as real calls (count toward cascade).
		const forceBypass = forceField?.force === true;
		const bypassAnnotation = toolName === "bash" && hasBypassAnnotation(bashCommand);

		if (forceBypass || bypassAnnotation) {
			if (this.#hasUI) {
				this.state.callCounter.record(toolName, sessionTurn, toolCallIndex, bashSubKey);
				this.state.toolCallIndex++;
				return null;
			}
			// hasUI is false → bypass rejected, fall through to normal guards
		}

		const meta = this.#getToolMeta(toolName);

		// ── 1. Pass-through tools → always pass, but record for cascade reset ──
		if (meta.passThrough) {
			this.state.callCounter.record(toolName, sessionTurn, toolCallIndex);
			this.state.toolCallIndex++;
			return null;
		}

		let result: ToolCallResult | null = null;

		// ── 2. Error tracking (gated on trackErrors — read-only tools are exempt) ──
		// Record the session turn (not toolCallIndex) so the block message's
		// "last turn N" names the same unit the read-cache message uses.
		if (event.isError && meta.trackErrors !== false) {
			this.state.errorTracker.push(toolName, { turn: sessionTurn, toolName });
			// result stays null → pass through
		}

		// ── 2.5 Cache invalidation (before blocking guards) ──
		// File-modifying tool calls invalidate the read cache
		if (toolName === "write" || toolName === "edit") {
			this.state.readCache.clear();
		} else if (bashCommand && isBashFileModify(bashCommand)) {
			this.state.readCache.clear();
		}

		// ── 3/4. Error retry & read cache blocking ──
		// Only runs for non-error events
		if (!event.isError) {
			// ── 3. Error retry blocking ──
			const errors = this.state.errorTracker.getLastErrors(toolName);
			if (shouldBlockRetry(errors.length)) {
				const lastErrorTurn = errors[errors.length - 1]?.turn ?? 0;
				result = {
					block: true,
					reason: `Tool ${toolName} errored ${errors.length}x (last turn ${lastErrorTurn}). Try a different approach or tool instead of retrying.`,
				};
			}

			// ── 4. Read caching (boolean-existence tracking with sessionTurn TTL) ──
			else if (toolName === "read") {
				const path = (args.path ?? "") as string;
				if (path) {
					const offset = (args.offset ?? 0) as number;
					const limit = (args.limit ?? "") as number;
					const cacheKey = `${path}|${offset}|${limit}`;
					const cached = this.state.readCache.get(cacheKey, sessionTurn);
					if (cached) {
						// Same-turn → pass through (let re-read happen in same turn)
						if (cached.turn === sessionTurn) {
							// result stays null, pass through
						} else if (!this.#hasUI) {
							// Non-TUI mode: bypass read cache block, pass through
						} else {
							result = {
								block: true,
								reason: `Content cached from turn ${cached.turn} — use offset/limit to page or re-read after 6 turns.`,
							};
						}
					} else {
						// Store existence marker to track that this path+offset+limit was recently read
						this.state.readCache.set(cacheKey, sessionTurn);
					}
				}
			}
		}

		// ── 5. Same-tool cascade detection (skip read — cache handles redundant reads) ──
		// Cascade check uses count + 1 BEFORE recording, accounting for current call
		// without recording it (if blocked, call is not real).
		// Uses bashSubKey for sub-command-aware cascade (Bug 3 fix).
		if (!result && toolName !== "read") {
			const cascadeThreshold = meta.cascadeThreshold ?? this.#resolvedRules.cascadeThreshold;
			const consecutive = this.state.callCounter.getConsecutive(toolName, bashSubKey);
			// Add 1 for current call (not yet recorded)
			const effectiveCount = consecutive.count + 1;
			if (effectiveCount >= cascadeThreshold) {
				const commandStr = (args.command ?? "") as string;
				const entry = BATCH_ADVICE[toolName];
				const suggestion =
					typeof entry === "function" ? entry(commandStr) : (entry ?? defaultAdvice(toolName));

				result = {
					block: true,
					reason: `Same-tool cascade: ${toolName} called ${effectiveCount}x consecutively. ${suggestion}.`,
				};
			}
		}

		// ── 6. Tool mismatch detection (bash only) ──
		if (!result && bashCommand) {
			// Search in bash (grep/rg) → redirect to ripgrep_search
			if (isBashSearch(bashCommand)) {
				result = {
					block: true,
					reason: buildRedirectMessage("ripgrep_search"),
					redirectTo: "ripgrep_search",
				};
			}

			// File read in bash (cat/less/more) → redirect to read
			else if (isBashFileRead(bashCommand)) {
				result = {
					block: true,
					reason: buildRedirectMessage("read"),
					redirectTo: "read",
				};
			}
			// ls is informational only — pass through at runtime (not blocked)
		}

		// ── 7. Record only if NOT blocked ──
		// Blocked calls (any guard) are NOT recorded (Bug 5 fix)
		// so they don't inflate the cascade counter.
		// Uses bashSubKey for sub-command-aware cascade (Bug 3 fix).
		if (!result) {
			this.state.callCounter.record(toolName, sessionTurn, toolCallIndex, bashSubKey);
		}

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
