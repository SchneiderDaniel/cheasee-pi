// ─── Requirements Traceability — Title / Diff Direction ───────────
// Pure title→verb extraction and title↔diff direction classification.

import type { TraceabilityGap } from "./types.ts";
import type { DiffEntry } from "./diff.ts";

/** Known imperative verbs for title→diff direction check. */
const IMPERATIVE_VERBS = new Set(["add", "implement", "create", "remove", "delete", "migrate"]);

/** Verbs that expect net file additions. */
const ADDITION_VERBS = new Set(["add", "implement", "create"]);

/** Verbs that expect net file deletions. */
const DELETION_VERBS = new Set(["remove", "delete", "migrate"]);

/**
 * Extract the imperative verb from an issue title.
 *
 * Matches the first word that is a known imperative verb ("add",
 * "implement", "create", "remove", "delete", "migrate"). Case-insensitive.
 * Returns null if no imperative verb is found.
 *
 * @param title - Issue title
 * @returns The matched verb (lowercase) or null
 */
export function extractTitleVerb(title: string): string | null {
	if (!title || title.trim() === "") return null;

	const trimmed = title.trim();

	// Check the first word of the original title (before any colon-separated prefix)
	// "add: new feature" → first word is "add"
	// "feat: add login" → first word is "feat" (not imperative), then check after "feat:"
	const firstColonIdx = trimmed.indexOf(":");
	let firstWord: string;

	if (firstColonIdx > 0) {
		// There's a colon — check if the part before colon is an imperative verb
		const beforeColon = trimmed.slice(0, firstColonIdx).trim().toLowerCase();
		if (IMPERATIVE_VERBS.has(beforeColon)) {
			return beforeColon;
		}
		// Otherwise, check the part after colon
		const afterColon = trimmed.slice(firstColonIdx + 1).trim();
		firstWord = afterColon.split(/\s+/)[0]?.toLowerCase() || "";
	} else {
		// No colon — first word is the first word
		firstWord = trimmed.split(/\s+/)[0]!.toLowerCase();
	}

	if (IMPERATIVE_VERBS.has(firstWord)) {
		return firstWord;
	}

	return null;
}

/**
 * Classify the expected diff direction based on issue title.
 *
 * Accepts a full issue title (not just a pre-extracted verb) so that
 * tests and callers can pass the title string directly. Internally
 * uses extractTitleVerb to derive the verb.
 *
 * Returns:
 * - "additions" if verb implies net addition of files
 * - "deletions" if verb implies net deletion of files
 * - null if verb is ambiguous, non-directional, or title is empty
 *
 * @param title - Issue title or pre-extracted verb (full title recommended)
 * @param _nameStatusLines - Lines from `git diff --name-status` (reserved for future use)
 * @returns Expected direction or null
 */
export function classifyDiffDirection(
	title: string | null,
	nameStatusLines: string[] = [],
): "additions" | "deletions" | null {
	if (!title || title.trim() === "") return null;

	// Extract verb from title (or use directly if it's already a verb)
	const trimmed = title.trim().toLowerCase();

	// Check for ambiguity in original title (both add and remove keywords)
	const hasAddWord = /\b(?:add|implement|create)\b/.test(trimmed);
	const hasRemoveWord = /\b(?:remove|delete)\b/.test(trimmed);
	if (hasAddWord && hasRemoveWord) return null; // Ambiguous, skip

	// Check diff lines for additions/deletions — if only modifications, can't classify
	const hasAdditions = nameStatusLines.some((l) => l.trim().startsWith("A"));
	const hasDeletions = nameStatusLines.some((l) => l.trim().startsWith("D"));
	if (!hasAdditions && !hasDeletions) return null; // No A or D in diff, can't classify

	// Try to extract the verb
	const verb = extractTitleVerb(title);
	if (!verb) return null;

	const verbLower = verb.toLowerCase();

	if (ADDITION_VERBS.has(verbLower)) return "additions";
	if (DELETION_VERBS.has(verbLower)) {
		// For "migrate from X to Y", expect deletions (old files removed)
		return "deletions";
	}

	return null;
}

/**
 * Check that the diff direction matches the issue title imperative verb.
 *
 * For "add"/"implement"/"create" titles: expects net additions (A > D).
 * For "remove"/"delete"/"migrate" titles: expects net deletions (D > A).
 *
 * Warning-only: does not block transition.
 *
 * @param titleVerb - Extracted imperative verb
 * @param title - Full issue title (for ambiguity re-check)
 * @param diffEntries - Parsed diff entries
 * @returns Array of gaps (at most one)
 */
export function checkTitleDiffDirection(
	titleVerb: string | null,
	title: string,
	diffEntries: DiffEntry[],
): TraceabilityGap[] {
	if (!titleVerb) return [];

	// Check for ambiguity in original title (both add and remove keywords)
	const titleLower = title.toLowerCase();
	const hasAddWord = /\b(?:add|implement|create)\b/.test(titleLower);
	const hasRemoveWord = /\b(?:remove|delete)\b/.test(titleLower);
	if (hasAddWord && hasRemoveWord) return []; // Ambiguous, skip

	// Count additions and deletions
	let additions = 0;
	let deletions = 0;

	for (const entry of diffEntries) {
		if (entry.status === "A") additions++;
		if (entry.status === "D") deletions++;
	}

	// If no additions or deletions, can't infer direction
	if (additions === 0 && deletions === 0) return [];

	const verbLower = titleVerb.toLowerCase();

	if (ADDITION_VERBS.has(verbLower)) {
		// Expect net additions
		if (deletions > additions) {
			return [
				{
					check: "title-diff-direction",
					severity: "info",
					detail: `Issue title suggests "additions" but diff has net deletions (+${additions}A, -${deletions}D). Verify this is intentional.`,
				},
			];
		}
	}

	if (DELETION_VERBS.has(verbLower)) {
		// Expect net deletions
		if (additions > deletions) {
			return [
				{
					check: "title-diff-direction",
					severity: "info",
					detail: `Issue title suggests "deletions" but diff has net additions (+${additions}A, -${deletions}D). Verify this is intentional.`,
				},
			];
		}
	}

	return [];
}
