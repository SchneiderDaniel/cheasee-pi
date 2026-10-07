/**
 * file-match.mts — shared extension-matching algorithm for adapters.
 *
 * Pure helper, zero domain semantics. Each adapter keeps its OWN extension
 * list (the lists differ); only the matching algorithm is shared.
 */

/**
 * Check whether `path` ends with any of `extensions` (case-insensitive).
 *
 * @param path       File path to test.
 * @param extensions Extension list owned by the calling adapter.
 */
export function matchesAnyExtension(path: string, extensions: readonly string[]): boolean {
	const lower = path.toLowerCase();
	return extensions.some((ext) => lower.endsWith(ext));
}
