/**
 * timed-map.ts — Generic Timed Map with TTL, max-entries, and decay
 *
 * A generic key-value store with configurable TTL (turn-based and/or time-based),
 * max-entries eviction, and decay support for array values.
 *
 * Replaces manual Map boilerplate in ReadCache, ErrorTracker, and CallCounter
 * within harness-state.ts by extracting a reusable building block.
 *
 * ### Usage
 *
 * ```ts
 * // Turn-based TTL (6 turns)
 * const cache = new TimedMap<string, ReadCacheEntry>({ ttlTurns: 6, ttlMs: 30_000 });
 * cache.turn = currentTurn; // synchronize turn before get/set
 * cache.set("key", value);
 * cache.get("key");          // null if expired
 * cache.clear();
 * ```
 *
 * ### Decay
 *
 * For array-valued maps (ErrorTracker), `decay()` removes 1 oldest element
 * from each per-key array, supporting turn-boundary auto-recovery.
 *
 * For non-array values it is a no-op.
 *
 * ### Internal turn tracking
 *
 * TimedMap stores each entry with the turn it was set at. The `.turn` property
 * is used as the "current turn" for TTL calculations in `get()` and `entries()`.
 * Wrappers that manage their own turn tracking can pass `currentTurn` to `get()`
 * or `turn` to `set()` instead.
 */

// ── Internal entry type ──

interface TimedEntry<V> {
	value: V;
	turn: number;
	timestamp: number;
}

// ── Public options type ──

export interface TimedMapOptions {
	/** Max total keys before evicting oldest by turn. No limit when undefined. */
	maxEntries?: number;
	/** Turn-based TTL: get() returns null when currentTurn - entryTurn >= ttlTurns. */
	ttlTurns?: number;
	/** Time-based TTL in ms: get() returns null when Date.now() - entryTs >= ttlMs. */
	ttlMs?: number;
}

// ── TimedMap class ──

export class TimedMap<K, V> {
	private map = new Map<K, TimedEntry<V>>();
	private _turn = 0;
	private options?: TimedMapOptions;

	/**
	 * @param options - optional TTL and max-entries config
	 */
	constructor(options?: TimedMapOptions) {
		this.options = options;
	}

	// ── Turn management ──

	/** Current turn used as default for TTL calculations in get()/entries(). */
	get turn(): number {
		return this._turn;
	}
	set turn(n: number) {
		this._turn = n;
	}

	// ── Core operations ──

	/**
	 * Get value for key.
	 * Returns null if key missing or expired (by turn-based or time-based TTL).
	 * Expired entries are automatically deleted from the internal map.
	 *
	 * @param key - the lookup key
	 * @param currentTurn - optional turn override (defaults to this.turn)
	 */
	get(key: K, currentTurn?: number): V | null {
		const entry = this.map.get(key);
		if (!entry) return null;
		const turn = currentTurn ?? this._turn;
		if (this.isExpired(entry, turn)) {
			this.map.delete(key);
			return null;
		}
		return entry.value;
	}

	/**
	 * Set value for key.
	 * Stores the value with the current turn and timestamp.
	 * If over maxEntries (when configured), the oldest entry by turn is evicted.
	 *
	 * @param key - the key
	 * @param value - the value to store
	 * @param turn - optional turn override (defaults to this.turn)
	 */
	set(key: K, value: V, turn?: number): void {
		const entryTurn = turn ?? this._turn;
		this.map.set(key, { value, turn: entryTurn, timestamp: Date.now() });
		this.evictIfOverMax();
	}

	/**
	 * Remove all entries.
	 */
	clear(): void {
		this.map.clear();
	}

	/**
	 * Delete a single key from the map.
	 * No-op if the key does not exist.
	 */
	delete(key: K): void {
		this.map.delete(key);
	}

	/**
	 * Remove 1 oldest element from each key's array value.
	 * Used by ErrorTracker at turn boundaries.
	 *
	 * For non-array values this is a no-op — the entry is left untouched.
	 * Empty arrays are preserved; the caller (wrapper) should clean them up
	 * via `delete()` if needed.
	 */
	decay(): void {
		for (const [, entry] of this.map) {
			if (Array.isArray(entry.value) && entry.value.length > 0) {
				entry.value.shift();
			}
		}
	}

	/**
	 * Get raw value without TTL check.
	 * Useful for batch-aware cache lookups that need to bypass expiry logic.
	 */
	peek(key: K): V | null {
		const entry = this.map.get(key);
		return entry ? entry.value : null;
	}

	/**
	 * Get all non-expired entries as [key, value] pairs.
	 * Filters out entries that have expired based on the current turn.
	 */
	entries(): [K, V][] {
		const result: [K, V][] = [];
		for (const [key, entry] of this.map) {
			if (!this.isExpired(entry, this._turn)) {
				result.push([key, entry.value]);
			}
		}
		return result;
	}

	/**
	 * Number of non-expired entries.
	 * Entries past their TTL are excluded from the count.
	 */
	get size(): number {
		let count = 0;
		for (const [, entry] of this.map) {
			if (!this.isExpired(entry, this._turn)) count++;
		}
		return count;
	}

	// ── Internal helpers ──

	private isExpired(entry: TimedEntry<V>, currentTurn: number): boolean {
		if (this.options?.ttlTurns !== undefined) {
			if (currentTurn - entry.turn >= this.options.ttlTurns) return true;
		}
		if (this.options?.ttlMs !== undefined) {
			if (Date.now() - entry.timestamp >= this.options.ttlMs) return true;
		}
		return false;
	}

	private evictIfOverMax(): void {
		if (this.options?.maxEntries === undefined) return;
		if (this.map.size <= this.options.maxEntries) return;

		// Evict oldest entry by turn
		let oldestKey: K | null = null;
		let oldestTurn = Infinity;
		for (const [key, entry] of this.map) {
			if (entry.turn < oldestTurn) {
				oldestTurn = entry.turn;
				oldestKey = key;
			}
		}
		if (oldestKey !== null) {
			this.map.delete(oldestKey);
		}
	}
}
