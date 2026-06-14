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
	BashCommand,
	buildRedirectMessage,
	MULTI_VERB_TOOLS,
	loadDefaultRules,
} from "./lib/harness-rules.ts";
import type { ResolvedHarnessRules, ToolMeta } from "./lib/harness-rules.ts";

// ── Types ──

export interface ToolCallResult {
	block: boolean;
	reason: string;
	redirectTo?: string;
}

interface ToolCallEvent {
	toolName?: string;
	input: Record<string, unknown>;
	isError?: boolean;
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
	 * Get tool meta from resolved rules with fallback to cascadeThreshold.
	 * Unlisted tools get { passThrough: false, cascadeThreshold: defaultThreshold }.
	 */
	#getToolMeta(toolName: string): ToolMeta {
		return (
			this.#resolvedRules.toolMeta[toolName] ?? {
				passThrough: false,
				cascadeThreshold: this.#resolvedRules.cascadeThreshold,
			}
		);
	}

	/**
	 * Validate a tool call against all guards.
	 * Returns null (pass-through) or ToolCallResult (block).
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
	 */
	handleToolCall(event: ToolCallEvent, _ctx: ToolCallContext): ToolCallResult | null {
		const toolName = event.toolName;
		const args = event.input ?? {};
		const toolCallIndex = this.state.toolCallIndex;
		const sessionTurn = this.state.sessionTurn;

		// ── Extract hasUI from context (backward-compatible cast) ──
		this.#hasUI = (_ctx as any).hasUI !== false;

		// ── Guard: undefined/empty toolName → skip recording, pass through ──
		if (!toolName) {
			this.state.toolCallIndex++;
			return null;
		}

		const meta = this.#getToolMeta(toolName);

		// ── 1. Pass-through tools → always pass, but record for cascade reset ──
		if (meta.passThrough) {
			this.state.callCounter.record(toolName, sessionTurn, toolCallIndex);
			this.state.toolCallIndex++;
			return null;
		}

		let result: ToolCallResult | null = null;
		// Parse bash command once if tool is bash (reused across guards)
		const bashCmd =
			toolName === "bash" && (args.command ?? "")
				? new BashCommand((args.command ?? "") as string)
				: undefined;

		// ── 2. Error tracking ──
		if (event.isError) {
			this.state.errorTracker.push(toolName, { turn: toolCallIndex, toolName });
			// result stays null → pass through
		}

		// ── 2.5 Cache invalidation (before blocking guards) ──
		// File-modifying tool calls invalidate the read cache
		if (toolName === "write" || toolName === "edit") {
			this.state.readCache.clear();
		} else if (bashCmd) {
			if (bashCmd.isFileModify()) {
				this.state.readCache.clear();
			}
		}

		// ── 3/4. Error retry & read cache blocking ──
		// Only runs for non-error events
		if (!event.isError) {
			// ── 3. Error retry blocking ──
			const errors = this.state.errorTracker.getLastErrors(toolName);
			if (errors.length >= 2) {
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
					const cached = this.state.readCache.get(cacheKey, sessionTurn, this.state.batchId);
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
						this.state.readCache.set(cacheKey, sessionTurn, this.state.batchId);
					}
				}
			}
		}

		// ── Extract bash subKey for sub-command-aware cascade detection ──
		// First 2 tokens of bash command become subKey. Empty/absent command → undefined.
		const bashSubKey =
			toolName === "bash" ? getBashSubKey((args.command ?? "") as string) : undefined;

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
				const suggestion =
					toolName === "bash"
						? commandStr.includes("&&")
							? "Reduce per-turn call count — commands already use && for batching"
							: "Combine bash calls with && or use a script file"
						: toolName === "read"
							? "Batch reads — read larger portions in one call"
							: `Batch ${toolName} calls to reduce turns`;

				result = {
					block: true,
					reason: `Same-tool cascade: ${toolName} called ${effectiveCount}x consecutively. ${suggestion}.`,
				};
			}
		}

		// ── 6. Tool mismatch detection (bash only) ──
		if (!result && bashCmd) {
			// Search in bash (grep/rg) → redirect to ripgrep_search
			if (bashCmd.isSearch()) {
				result = {
					block: true,
					reason: buildRedirectMessage("ripgrep_search"),
					redirectTo: "ripgrep_search",
				};
			}

			// File read in bash (cat/head/tail) → redirect to read
			else if (bashCmd.isFileRead()) {
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
