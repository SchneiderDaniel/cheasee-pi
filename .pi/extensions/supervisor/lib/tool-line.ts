// ─── Tool-call line detection ──────────────────────────────────────
// Single canonical location for isToolLine and getBuiltinToolLabels.
// No pi-tui / pi-coding-agent dependencies — safe for formatting.ts
// and other "pure" modules to import.
//
// isToolLine matches rendered tool-call lines by first word.
// Not a regex predicate — uses session-state tool names.
// bash lines start with "$", built-in/extension lines start with tool name.
//
// Extension tools (ripgrep_search, web_search, etc.) that render as
// "name: {...}" are matched by stripping the trailing colon from firstWord.

const DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "rg"] as const;

/**
 * Return the set of default built-in tool names.
 * Used as the default tool set when no session-state names are available.
 */
export function getBuiltinToolLabels(): Set<string> {
	return new Set(DEFAULT_TOOL_NAMES);
}

/**
 * Check if a line is a rendered tool-call line.
 *
 * Only TWO rules (no format regex):
 * 1. Lines starting with `$` (bash tool calls).
 * 2. Lines whose first word (trailing colon stripped) matches a known tool name.
 *
 * When toolNames is provided (from session state), uses those names.
 * Otherwise falls back to getBuiltinToolLabels().
 *
 * This is NOT a regex predicate — it delegates to session-state knowledge.
 */
export function isToolLine(l: string, toolNames?: Set<string>): boolean {
	if (!l) return false;
	if (l.startsWith("$ ") || l === "$") return true;
	// Strip trailing colon — extension tools render as "name: {...}"
	const firstWord = l.trimStart().split(" ")[0].replace(/:$/, "");
	if (!firstWord) return false;
	const names = toolNames ?? getBuiltinToolLabels();
	return names.has(firstWord);
}
