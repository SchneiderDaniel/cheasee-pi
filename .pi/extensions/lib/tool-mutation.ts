/**
 * tool-mutation.ts — Pure, fail-closed mutation classification for search caches.
 *
 * Layer: domain — pure functions, no I/O, no pi runtime import. Shared by
 * ripgrep-search (and structural-analyzer) so the two search caches cannot
 * diverge on which completed tools may have invalidated the corpus.
 *
 * Policy: only tools on the read-only allowlist preserve a cache; every other
 * tool — including tools that do not exist yet — invalidates (fail-closed).
 */

/**
 * Tools that cannot mutate the filesystem, so a completed call cannot make a
 * cached search result stale. Exact-match by name: an unknown casing or an
 * unlisted name fails closed.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"ripgrep_search",
	"structural_search",
	"web_search",
	"web_crawl",
	"ask_user",
	"ask_user_read",
]);

/**
 * True when a completed tool may have mutated the corpus and the search cache
 * must therefore be cleared.
 *
 * Fail-closed: anything not on {@link READ_ONLY_TOOL_NAMES} — including an
 * unknown future tool, a non-string name, or an empty string — returns true.
 *
 * @param toolName the completed tool's name
 * @param _input  the tool input; accepted for call-site symmetry, unused
 */
export function shouldInvalidateSearchCache(
	toolName: string,
	_input?: Record<string, unknown>,
): boolean {
	if (typeof toolName !== "string") return true;
	return !READ_ONLY_TOOL_NAMES.has(toolName);
}
