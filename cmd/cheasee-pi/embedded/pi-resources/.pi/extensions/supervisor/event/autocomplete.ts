// ─── Autocomplete Provider: # Issue Trigger ─────────────────────
// Registers an autocomplete provider triggered by `#` for issue numbers.
// Fetches open issues from the supervisor's configured GitHub repo.
// Uses fuzzyFilter from @earendil-works/pi-tui for local matching.
// Cache: module-level promise per session_start (not per keystroke).

import type { SupervisorConfig } from "../config/types.ts";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────

export interface IssueItem {
	number: number;
	title: string;
	state: string;
}

// ─── Regex ──────────────────────────────────────────────────────────

/**
 * Extract the partial issue token after `#` at end of input or after whitespace.
 * Matches patterns like " #", " #123", "fix #456" at the end of input.
 * Does NOT match "abc#123" (no space before #).
 */
export const ISSUE_TOKEN_RE = /(?:^|[ \t])#([^\s#]*)$/;

// ─── Issue Cache ────────────────────────────────────────────────────

/**
 * Module-level cache: fetched once per session_start, reused per keystroke.
 * The cache is invalidated on each new session_start event.
 */
let cachedIssuesPromise: Promise<IssueItem[]> | null = null;

/**
 * Fetch open issues from the configured GitHub repo.
 * Cached per session_start lifecycle.
 */
export function fetchOpenIssues(
	execFn: (
		cmd: string,
		args: string[],
	) => Promise<{ code: number; stdout: string; stderr: string }>,
	repo: string,
): Promise<IssueItem[]> {
	if (cachedIssuesPromise) return cachedIssuesPromise;

	cachedIssuesPromise = (async (): Promise<IssueItem[]> => {
		try {
			const result = await execFn("gh", [
				"issue",
				"list",
				"--repo",
				repo,
				"--state",
				"open",
				"--limit",
				"100",
				"--json",
				"number,title,state",
			]);
			if (result.code !== 0) {
				return [];
			}
			const issues: IssueItem[] = JSON.parse(result.stdout || "[]");
			return issues;
		} catch {
			// Graceful fallback: gh not installed or other error
			return [];
		}
	})();

	return cachedIssuesPromise;
}

/**
 * Reset the cached issues promise. Called on session_start to force
 * a fresh fetch on the next keystroke.
 */
export function resetIssueCache(): void {
	cachedIssuesPromise = null;
}

/**
 * Extract the partial issue token after `#` at the cursor position.
 * Returns the partial token text, or null if no `#` trigger is active.
 */
function extractIssueToken(lines: string[], cursorLine: number, cursorCol: number): string | null {
	const currentLine = lines[cursorLine] || "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	const match = textBeforeCursor.match(ISSUE_TOKEN_RE);
	return match ? match[1] || "" : null;
}

// ─── Autocomplete Provider Factory ──────────────────────────────────

/**
 * Build an autocomplete provider factory triggered by `#` for issue numbers.
 *
 * The factory wraps the current built-in autocomplete provider.
 * When `#` is detected at the cursor, it fetches open issues and
 * filters them locally using the partial token after `#`.
 * Otherwise, it delegates to the current provider.
 *
 * @param config - Supervisor config (provides repo name)
 * @param execFn - Function to execute shell commands (e.g., pi.exec)
 * @returns An AutocompleteProviderFactory
 */
export function createIssueAutocompleteProvider(
	config: SupervisorConfig,
	execFn: (
		cmd: string,
		args: string[],
	) => Promise<{ code: number; stdout: string; stderr: string }>,
): AutocompleteProviderFactory {
	return (current: AutocompleteProvider): AutocompleteProvider => {
		return {
			getSuggestions: async (lines, cursorLine, cursorCol, options) => {
				const partial = extractIssueToken(lines, cursorLine, cursorCol);

				if (partial === null) {
					// No `#` trigger — delegate to current provider
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				try {
					const issues = await fetchOpenIssues(execFn, config.repo);

					// Filter locally by partial token
					const filtered = partial
						? issues.filter(
								(issue) =>
									String(issue.number).includes(partial) ||
									issue.title.toLowerCase().includes(partial),
							)
						: issues;

					const items: AutocompleteItem[] = filtered.map((issue) => ({
						value: `#${issue.number}`,
						label: `#${issue.number}: ${issue.title}`,
						description: issue.state === "OPEN" ? "Open" : issue.state,
					}));

					return {
						items,
						prefix: partial,
					};
				} catch {
					// Graceful fallback: delegate on error
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
		};
	};
}
