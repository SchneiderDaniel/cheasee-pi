/**
 * harness-state.ts — In-memory runtime state for agent-harness
 *
 * Read cache, error tracker, call counter.
 * Factory pattern: createHarnessState() produces isolated instance per session.
 * No globals, no singletons.
 *
 * All three state components delegate storage to TimedMap<K,V>,
 * removing ~60 lines of duplicated Map boilerplate.
 *
 * Used by:
 *  - agent-harness extension handlers (pi.on("tool_call"))
 *
 * Exports HarnessState (the only outward contract) plus value-type interfaces
 * ReadCacheEntry, ErrorEntry, ConsecutiveInfo.  The readCache/errorTracker/
 * callCounter fields are inline anonymous object types — no standalone
 * ReadCache/ErrorTracker/CallCounter interfaces.
 */

// ── Types ──

/** @public */
export interface ReadCacheEntry {
	turn: number;
	timestamp: number;
}

/** @public */
export interface ErrorEntry {
	/** Session turn in which the error occurred (0-based, mirrors ReadCacheEntry.turn). */
	turn: number;
	toolName: string;
	/** Optional error detail/message. */
	message?: string;
}

/** @public */
export interface ConsecutiveInfo {
	toolName: string;
	count: number;
	sinceTurn: number;
}

export interface HarnessState {
	readCache: {
		/** Get cached entry. Returns null on miss or TTL expiry. */
		get(key: string, currentTurn: number): ReadCacheEntry | null;
		/** Set cached entry with current turn and timestamp. */
		set(key: string, turn: number): void;
		/** Clear all cache entries. */
		clear(): void;
	};
	errorTracker: {
		/** Push a new error for a tool. Evicts oldest if over MAX_ERRORS_PER_TOOL. */
		push(toolName: string, entry: ErrorEntry): void;
		/** Get last N errors for a tool (up to MAX_ERRORS_PER_TOOL). */
		getLastErrors(toolName: string): ErrorEntry[];
		/** Clear all error entries. */
		clear(): void;
		/**
		 * Decay errors: remove 1 oldest error entry per tool.
		 * Called at each turn boundary alongside callCounter.turnBoundaryReset().
		 * Enables auto-recovery: after 2 turns without errors, a tool with 2 errors
		 * decays to 0 and is unblocked.
		 */
		decay(): void;
	};
	callCounter: {
		/**
		 * Record a tool call. Resets consecutive count if composite key changes.
		 * Composite key = toolName:subKey (when subKey provided) or just toolName.
		 * Different subKey within same tool resets the counter.
		 *
		 * @param toolName - name of the tool being called
		 * @param sessionTurn - current session turn number (for sinceTurn tracking)
		 * @param _toolCallIndex - current tool call index (unused internally, for API symmetry)
		 * @param subKey - optional sub-key for sub-command-aware cascade
		 */
		record(toolName: string, sessionTurn: number, _toolCallIndex: number, subKey?: string): void;
		/**
		 * Roll a nested call up under its parent's existing consecutive entry.
		 * Resolves the parent's composite identity (incl. bash sub-key) from its
		 * last recorded call; never creates an entry. Re-asserts the parent as the
		 * active chain key so the roll-up is visible to `getConsecutive` even when
		 * a sibling interleaved. No-op when the parent has no recorded entry.
		 */
		recordNested(toolName: string, sessionTurn: number): void;
		/**
		 * Get consecutive call info for a composite key.
		 * Returns count 0 if composite key doesn't match the last recorded key.
		 */
		getConsecutive(toolName: string, subKey?: string): ConsecutiveInfo;
		/** Reset all counters. Clears the call-id index too. */
		reset(): void;
		/**
		 * Reset consecutive count on turn boundary.
		 * Clears lastKey so the next record() starts a fresh consecutive chain.
		 * Also clears the nested-attribution call-id index.
		 * Does NOT affect toolCallIndex (cache TTL) — only resets cascade state.
		 */
		turnBoundaryReset(): void;
	};
	/**
	 * Nested-call attribution index: model-issued (and nested) toolCallId → toolName.
	 * Bounded by CACHE_TTL_TURNS; cleared on turn boundary and reset.
	 */
	callIdIndex: TimedMap<string, string>;
	/**
	 * Tool call index for cache TTL and error tracking.
	 * Incremented on each tool_call event handled by the extension.
	 * Monotonic — never reset by turn boundaries.
	 */
	toolCallIndex: number;
	/**
	 * Session turn number (conversation response cycle).
	 * Incremented by turn_start handler.
	 * Used for cascade detection (sinceTurn tracking).
	 */
	sessionTurn: number;
}

// ── Constants ──

import { CACHE_TTL_TURNS } from "./harness-rules.ts";
import { TimedMap } from "./timed-map.ts";
const MAX_ERRORS_PER_TOOL = 3;

/** Time-based TTL for cache entries (in ms). 30 seconds. */
export const CACHE_TTL_MS = 30_000;

// ── Factory ──

/**
 * Create a fresh, isolated harness state instance.
 * Each agent session gets its own state via this factory.
 */
export function createHarnessState(): HarnessState {
	// ── Read Cache (TimedMap with dual TTL) ──

	const cacheMap = new TimedMap<string, ReadCacheEntry>({
		ttlTurns: CACHE_TTL_TURNS,
		ttlMs: CACHE_TTL_MS,
	});

	const readCache = {
		get(key: string, currentTurn: number): ReadCacheEntry | null {
			return cacheMap.get(key, currentTurn);
		},

		set(key: string, turn: number): void {
			cacheMap.set(
				key,
				{
					turn,
					timestamp: Date.now(),
				},
				turn,
			);
		},

		clear(): void {
			cacheMap.clear();
		},
	} satisfies HarnessState['readCache'];

	// ── Error Tracker (TimedMap with per-key array storage + decay) ──

	const errorMap = new TimedMap<string, ErrorEntry[]>();

	const errorTracker = {
		push(toolName: string, entry: ErrorEntry): void {
			let errors = errorMap.get(toolName);
			if (!errors) {
				errors = [];
			}
			errors.push(entry);
			if (errors.length > MAX_ERRORS_PER_TOOL) {
				errors.shift();
			}
			errorMap.set(toolName, errors);
		},

		getLastErrors(toolName: string): ErrorEntry[] {
			return errorMap.get(toolName) ?? [];
		},

		clear(): void {
			errorMap.clear();
		},

		decay(): void {
			// Remove 1 oldest error per tool via TimedMap.decay (array shift)
			errorMap.decay();
			// Clean up empty arrays left by decay
			for (const [toolName, errors] of errorMap.entries()) {
				if (errors.length === 0) {
					errorMap.delete(toolName);
				}
			}
		},
	} satisfies HarnessState['errorTracker'];

	// ── Call Counter (TimedMap with composite-key + lastKey tracking) ──

	interface ConsecutiveState {
		toolName: string;
		count: number;
		sinceTurn: number;
	}

	let lastKey: string | null = null;
	const callMap = new TimedMap<string, ConsecutiveState>();
	/**
	 * Last composite key recorded per tool name. Preserves the parent's counter
	 * identity (e.g. `bash\x00git commit`) independently of the global `lastKey`
	 * chain, so nested roll-ups reach the right sub-keyed entry.
	 */
	const keyByTool = new Map<string, string>();

	// Nested-call attribution: toolCallId → toolName, turn-bounded.
	const callIdMap = new TimedMap<string, string>({ ttlTurns: CACHE_TTL_TURNS });

	/** Build composite key from toolName and optional subKey. */
	function makeKey(toolName: string, subKey?: string): string {
		return subKey !== undefined ? `${toolName}\x00${subKey}` : toolName;
	}

	const callCounter = {
		record(toolName: string, sessionTurn: number, _toolCallIndex: number, subKey?: string): void {
			const key = makeKey(toolName, subKey);
			keyByTool.set(toolName, key);
			if (key === lastKey) {
				// Same composite key — increment consecutive count
				const existing = callMap.get(key);
				if (existing) {
					existing.count++;
					// In-place mutation; no need to re-set
				}
			} else {
				// Composite key changed — start fresh chain
				lastKey = key;
				callMap.set(key, { toolName, count: 1, sinceTurn: sessionTurn });
			}
		},

		getConsecutive(toolName: string, subKey?: string): ConsecutiveInfo {
			const key = makeKey(toolName, subKey);
			const state = callMap.get(key);
			if (!state || key !== lastKey) {
				return { toolName: "", count: 0, sinceTurn: 0 };
			}
			return {
				toolName: state.toolName,
				count: state.count,
				sinceTurn: state.sinceTurn,
			};
		},

		recordNested(toolName: string, _sessionTurn: number): void {
			// Resolve the parent's composite identity (incl. bash sub-key) from its
			// last recorded call. Never create an entry; a mapped id whose parent
			// was never recorded (or was cleared) is a no-op.
			const key = keyByTool.get(toolName);
			if (key === undefined) return;
			const existing = callMap.get(key);
			if (!existing) return;
			existing.count++;
			// Re-assert the parent as the active chain key so getConsecutive()
			// exposes the roll-up even when a sibling interleaved before it.
			lastKey = key;
		},

		reset(): void {
			callMap.clear();
			callIdMap.clear();
			keyByTool.clear();
			lastKey = null;
		},

		turnBoundaryReset(): void {
			callMap.clear();
			callIdMap.clear();
			keyByTool.clear();
			lastKey = null;
		},
	} satisfies HarnessState['callCounter'];

	return {
		readCache,
		errorTracker,
		callCounter,
		callIdIndex: callIdMap,
		toolCallIndex: 0,
		sessionTurn: 0,
	};
}
