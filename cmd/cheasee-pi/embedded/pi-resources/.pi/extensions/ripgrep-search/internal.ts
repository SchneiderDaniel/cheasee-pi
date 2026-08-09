/**
 * Internal utilities for ripgrep-search — merged from validate.ts, temp.ts, cache.ts.
 *
 * Pure functions — no dependencies on pi SDK or other modules.
 * Consolidates three pass-through modules into one for reduced file-bouncing.
 */

import type { ExtensionMode, RgResult } from "./types.ts";

// ═══════════════════════════════════════════════════════════════════════
// Extension mode — owned here, consumed by renderers via getCtxMode
// ═══════════════════════════════════════════════════════════════════════

let _ctxMode: ExtensionMode | undefined;

/** Set ctx mode (called by both production session_start and tests). */
export function setTestCtxMode(mode: ExtensionMode | undefined): void {
	_ctxMode = mode;
}

/** Read ctx mode (consumed by renderCallImpl / renderResultImpl in index.ts). */
export function getCtxMode(): ExtensionMode | undefined {
	return _ctxMode;
}

// ═══════════════════════════════════════════════════════════════════════
// Query validation
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate that a query is suitable for ripgrep (literal/regex text search)
 * rather than structural/syntax-aware search.
 *
 * Collision rule:
 * - Empty or whitespace-only strings are rejected
 * - Patterns starting with `class `, `def `, `function ` are rejected —
 *   agent should use structural_search (ast-grep) for class/def searches
 * - Patterns containing `$` or `{` (structural AST syntax) are rejected —
 *   agent should use structural_search (ast-grep) for structural searches
 *
 * Returns null if valid, or an error string if invalid.
 */
export function validateQuery(query: string): string | null {
	if (!query || typeof query !== "string") {
		return "Query must be a non-empty string";
	}

	const trimmed = query.trim();
	if (!trimmed) {
		return "Query must be a non-empty string";
	}

	// Reject patterns that look like structural/symbol searches
	if (trimmed.startsWith("class ")) {
		return `Query "${trimmed}" looks like a class definition search. Use structural_search (ast-grep) to find class definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("def ")) {
		return `Query "${trimmed}" looks like a function definition search. Use structural_search (ast-grep) to find function definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("function ")) {
		return `Query "${trimmed}" looks like a function definition search. Use structural_search (ast-grep) to find function definitions, not ripgrep_search.`;
	}

	// Reject patterns with structural AST syntax ($ or {)
	if (trimmed.includes("$") || trimmed.includes("{")) {
		return `Query "${trimmed}" contains structural syntax ($ or {). Use structural_search (ast-grep) for structural code pattern matching, not ripgrep_search.`;
	}

	return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Temp directory tracking + lifecycle cleanup
// ═══════════════════════════════════════════════════════════════════════

/** @internal Exported for testability — allows tests to inspect state. */
export const trackedTempDirs = new Set<string>();

/** Register a temp directory for deferred cleanup at session end. */
export function registerTempDir(dir: string): void {
	trackedTempDirs.add(dir);
}

/**
 * Clean up all tracked temp directories.
 * Accepts rm function for testability (mock injection).
 */
export async function cleanupTrackedTempDirs(
	rmFn: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>,
): Promise<void> {
	for (const dir of trackedTempDirs) {
		await rmFn(dir, { recursive: true, force: true });
	}
	trackedTempDirs.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// In-memory result cache
// ═══════════════════════════════════════════════════════════════════════

/** Cache entry stored for each unique query+directory */
export interface RgCacheEntry {
	result: RgResult;
	rawStdout: string;
}

/** @internal Exported for testability */
export const resultCache = new Map<string, RgCacheEntry>();

const MAX_CACHE_ENTRIES = 100;

/** Normalize a directory path for consistent cache keying. */
function normalizeDirectory(dir: string): string {
	return dir.replace(/\/+$/, "").replace(/^\.\//, "") || ".";
}

/** Build a cache key from query and directory (normalizes the directory). */
export function buildCacheKey(query: string, directory: string): string {
	return JSON.stringify({ query, directory: normalizeDirectory(directory) });
}

/** Look up a cached search result. Returns undefined on miss. */
export function getCachedResult(query: string, directory: string): RgCacheEntry | undefined {
	return resultCache.get(buildCacheKey(query, directory));
}

/**
 * Store a search result in the cache.
 * Evicts oldest entry (by insertion order) when at max capacity and key is new.
 */
export function setCachedResult(query: string, directory: string, entry: RgCacheEntry): void {
	const key = buildCacheKey(query, directory);

	// If at max capacity and this is a new key, evict oldest by insertion order
	if (resultCache.size >= MAX_CACHE_ENTRIES && !resultCache.has(key)) {
		const oldestKey = resultCache.keys().next().value;
		if (oldestKey !== undefined) {
			resultCache.delete(oldestKey);
		}
	}

	resultCache.set(key, entry);
}

/** Clear all cached results (called on session_shutdown). */
export function clearCache(): void {
	resultCache.clear();
}


