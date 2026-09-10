// ─── Requirements Traceability — Issue Body Parsing ────────────────
// Pure string→data parsing of the issue body (checklists) and
// per-item keyword extraction. No exec/fs interaction.

import type { ChecklistItem, ChecklistKeywords } from "./types.ts";

/** Meta-headings under which checklist items should be excluded. */
const EXCLUDED_HEADINGS = new Set([
	"prerequisites",
	"setup",
	"reproduction steps",
	"steps to reproduce",
]);

/**
 * Normalize a raw ATX heading text for exclusion comparison.
 *
 * Strips the optional CommonMark closing `#` run (only when preceded by
 * whitespace, so `## C# notes` survives), inline formatting markers, and a
 * trailing colon, then lowercases.
 */
function normalizeHeadingText(raw: string): string {
	return raw
		.replace(/\s+#+\s*$/, "") // optional closing ATX sequence
		.replace(/`([^`]+)`/g, "$1") // inline code
		.replace(/\*\*([^*]+)\*\*/g, "$1") // bold
		.replace(/\*([^*]+)\*/g, "$1") // italic
		.replace(/_([^_]+)_/g, "$1") // underscore emphasis
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
		.replace(/\s*:\s*$/, "") // trailing colon
		.trim()
		.toLowerCase();
}

/** Stop words to filter out from checklist keywords. */
const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"to",
	"for",
	"of",
	"in",
	"on",
	"at",
	"by",
	"with",
	"from",
	"and",
	"or",
	"but",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"can",
	"could",
	"shall",
	"should",
	"may",
	"might",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"they",
	"them",
]);

/**
 * Parse an issue body for GFM task list items (checklists).
 *
 * Returns all checklist items, excluding those under known meta-headings
 * (Prerequisites, Setup, Reproduction steps / Steps To Reproduce). ATX
 * headings H1–H6 are recognized per CommonMark; heading text is normalized
 * (formatting markers, closing `#` run, trailing colon, case) before the
 * exclusion compare. Fenced-code content and blockquote lines never flip
 * section state. Items are returned with their text content and checked
 * status.
 *
 * @param body - Issue body text
 * @returns Array of parsed checklist items
 */
export function parseIssueBodyChecklists(body: string): ChecklistItem[] {
	if (!body || body.trim() === "") return [];

	const lines = body.split("\n");

	// Track the current heading section
	let currentHeading = "";
	let inFence = false;
	const items: ChecklistItem[] = [];

	for (const line of lines) {
		// Fenced code: toggle on fence markers, ignore everything inside.
		// ponytail: naive toggle — nested/hybrid fences and >3-space-indented
		// fences are accepted limitations (see module JSDoc).
		if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		// Blockquote lines (e.g. quoted templates) never flip section state.
		if (/^\s{0,3}>/.test(line)) continue;

		// Detect ATX headings (# .. ######, per CommonMark).
		const headingMatch = line.match(/^#{1,6}\s+(.+)/i);
		if (headingMatch) {
			currentHeading = normalizeHeadingText(headingMatch[1]!);
			continue;
		}

		// Detect checklist items: - [ ] text or - [x] text (also * and + bullets)
		const checklistMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)/);
		if (!checklistMatch) continue;

		const checked = checklistMatch[1]!.toLowerCase() === "x";
		const text = checklistMatch[2]!.trim();

		// Skip items under excluded headings
		if (EXCLUDED_HEADINGS.has(currentHeading)) continue;

		// If no heading has been seen yet, include (default behavior)
		items.push({ text, checked });
	}

	return items;
}

/**
 * Extract significant keywords from checklist items.
 *
 * For each item, splits text into words, strips punctuation, removes
 * stop words, and returns meaningful keywords. Also strips markdown
 * formatting artifacts (backticks, bold markers, link syntax).
 *
 * @param items - Checklist items
 * @returns Array of per-item keyword sets
 */
export function extractChecklistKeywords(items: ChecklistItem[]): ChecklistKeywords[] {
	if (items.length === 0) return [];

	return items.map((item) => {
		// Strip markdown formatting: backticks, bold, links
		let text = item.text
			.replace(/`([^`]+)`/g, "$1") // inline code
			.replace(/\*\*([^*]+)\*\*/g, "$1") // bold
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // links

		// Split into words and filter
		const words = text
			.split(/\s+/)
			.map((w) => {
				// Strip leading/trailing punctuation
				return w.replace(/^[^\w]+/, "").replace(/[^\w]+$/, "");
			})
			.filter(Boolean);

		// Remove stop words and short words (< 2 chars)
		const keywords = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()) && w.length >= 2);

		return { item: item.text, keywords };
	});
}
