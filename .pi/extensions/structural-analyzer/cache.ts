/**
 * cache.ts — FIFO bounded result cache for structural-analyzer.
 *
 * Stores ExecResultResponse entries keyed by `${pattern}\x00${language}\x00${cwd}`.
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

/** Module-level result cache keyed by `${pattern}\x00${language}\x00${cwd}`. */
const RESULT_CACHE = new Map<string, ExecResultResponse>();

/**
 * Clear the result cache. Useful for testing and when the underlying
 * filesystem/codebase may have changed between searches.
 */
export function clearResultCache(): void {
	RESULT_CACHE.clear();
}

/**
 * Get a cached result by key.
 * Returns undefined if no entry exists for the given key.
 */
export function getCache(key: string): ExecResultResponse | undefined {
	return RESULT_CACHE.get(key);
}

/**
 * Set a cache entry with FIFO eviction when the cache exceeds MAX_CACHE_SIZE.
 * Evicts the oldest entry (first inserted) when at capacity.
 */
export function setCache(key: string, value: ExecResultResponse): void {
	if (RESULT_CACHE.size >= MAX_CACHE_SIZE) {
		const firstKey = RESULT_CACHE.keys().next().value;
		if (firstKey !== undefined) {
			RESULT_CACHE.delete(firstKey);
		}
	}
	RESULT_CACHE.set(key, value);
}

/**
 * Build a deterministic cache key from search parameters.
 * Uses '\x00' (null byte) as separator — cannot appear in normal UTF-8 text input,
 * eliminating collision risk when pattern, language, or cwd contain '::'.
 */
export function makeCacheKey(pattern: string, language: string, cwd: string): string {
	return `${pattern}\x00${language}\x00${cwd}`;
}
