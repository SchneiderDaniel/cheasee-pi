/**
 * cache.ts — FIFO bounded result cache for structural-analyzer.
 *
 * Stores ExecResultResponse entries keyed by
 * `${epoch}\x00${pattern}\x00${language}\x00${cwd}`.
 *
 * The leading `epoch` is a monotonic "world version". It is bumped by
 * clearResultCache(), which invalidation.ts calls when a write/edit tool result
 * means the codebase may have changed. An in-flight search that captured the
 * pre-mutation epoch writes back an entry that is unreachable under the new
 * epoch — a plain clear() alone would let it resurrect a pre-edit payload.
 * FIFO eviction when cache exceeds MAX_CACHE_SIZE (200 entries).
 * This is an intentional design choice: simple, predictable eviction.
 * Hot-spot patterns may evict cold entries first; revisit LRU when usage data exists.
 *
 * The '\x00' null byte separator prevents collision when pattern, language,
 * or cwd contain '::'. Null bytes in JavaScript Map keys from agent-generated
 * inputs (not user input) are not exploitable — CWE-158 is immaterial here.
 */

import type { ExecResultResponse } from "./types.ts";

/** Maximum number of entries in the result cache before FIFO eviction. */
export const MAX_CACHE_SIZE = 200;

/** Module-level result cache keyed by `${epoch}\x00${pattern}\x00${language}\x00${cwd}`. */
const RESULT_CACHE = new Map<string, ExecResultResponse>();

/** Monotonic world version. Bumped whenever the codebase may have changed. */
let epoch = 0;

/**
 * Current cache epoch. Callers read this once at the request boundary and
 * reuse the value for both the pre-exec lookup and the post-exec write-back —
 * never re-read it mid-request, or an in-flight mutation could be missed.
 */
export function currentCacheEpoch(): number {
	return epoch;
}

function entryKey(key: string, e: number): string {
	return `${e}\x00${key}`;
}

/**
 * Clear the result cache and bump the epoch. Called when a write/edit tool
 * result means the codebase may have changed (see invalidation.ts), and on
 * session_start to prevent cross-session bleed.
 *
 * Bumping the epoch — rather than only clearing — makes any stale in-flight
 * write-back from the previous epoch unreachable instead of readable.
 */
export function clearResultCache(): void {
	RESULT_CACHE.clear();
	epoch++;
}

/**
 * Get a cached result by request key at the given epoch.
 * Returns undefined if no entry exists for that request in that world version.
 */
export function getCache(key: string, e: number): ExecResultResponse | undefined {
	return RESULT_CACHE.get(entryKey(key, e));
}

/**
 * Set a cache entry with FIFO eviction when the cache exceeds MAX_CACHE_SIZE.
 * Evicts the oldest entry (first inserted) when at capacity. Entries are
 * qualified by the world-version `e` captured at the request boundary.
 */
export function setCache(key: string, value: ExecResultResponse, e: number): void {
	const k = entryKey(key, e);
	if (RESULT_CACHE.size >= MAX_CACHE_SIZE && !RESULT_CACHE.has(k)) {
		const firstKey = RESULT_CACHE.keys().next().value;
		if (firstKey !== undefined) {
			RESULT_CACHE.delete(firstKey);
		}
	}
	RESULT_CACHE.set(k, value);
}

/**
 * Build a deterministic cache key from search parameters.
 * Uses '\x00' (null byte) as separator — cannot appear in normal UTF-8 text input,
 * eliminating collision risk when pattern, language, or cwd contain '::'.
 */
export function makeCacheKey(pattern: string, language: string, cwd: string): string {
	return `${pattern}\x00${language}\x00${cwd}`;
}
