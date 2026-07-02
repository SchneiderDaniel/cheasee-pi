// ─── Requirements Traceability ──────────────────────────────────────
// Deterministic checks that cross-reference issue requirements against
// implementation diff. Runs after developer completes, before
// Implementation→Audit transition. Produces structured gap list for
// the auditor agent (non-blocking).

import { existsSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";

/** Exec function type for subprocess calls (3-field return — code, stdout, stderr) */
export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

// ─── Types ──────────────────────────────────────────────────────────

/** A single traceability gap found by one of the deterministic checks. */
export interface TraceabilityGap {
	/** Check identifier (e.g. "checklist-keyword-coverage", "test-file-parity") */
	check: string;
	/** Severity: "info" for advisory, "warning" for likely issues */
	severity: "info" | "warning";
	/** Human-readable detail about the gap */
	detail: string;
}

/** A parsed checklist item from issue body. */
export interface ChecklistItem {
	text: string;
	checked: boolean;
}

/** Keywords extracted for a single checklist item. */
export interface ChecklistKeywords {
	item: string;
	keywords: string[];
}

/** Filtered issue data (body + trusted comments). */
export interface FilteredIssueData {
	body: string;
	comments: Array<{ author: string; body: string }>;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Known imperative verbs for title→diff direction check. */
const IMPERATIVE_VERBS = new Set(["add", "implement", "create", "remove", "delete", "migrate"]);

/** Verbs that expect net file additions. */
const ADDITION_VERBS = new Set(["add", "implement", "create"]);

/** Verbs that expect net file deletions. */
const DELETION_VERBS = new Set(["remove", "delete", "migrate"]);

/** Meta-headings under which checklist items should be excluded. */
const EXCLUDED_HEADINGS = new Set(["prerequisites", "setup", "reproduction steps"]);

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

// ─── Import isTestableFile from file-classification.ts ─────────────

import { isTestableFile as _isTestableFile } from "./file-classification.ts";

/**
 * Check whether a source file is testable (should have a corresponding test file).
 * Re-exported from file-classification.ts for use by the test-parity check.
 */
export function isTestableFile(filePath: string): boolean {
	return _isTestableFile(filePath);
}

// ─── Issue Body Parsing ─────────────────────────────────────────────

/**
 * Parse an issue body for GFM task list items (checklists).
 *
 * Returns all checklist items, excluding those under known meta-headings
 * (Prerequisites, Setup, Reproduction steps). Items are returned with
 * their text content and checked status.
 *
 * @param body - Issue body text
 * @returns Array of parsed checklist items
 */
export function parseIssueBodyChecklists(body: string): ChecklistItem[] {
	if (!body || body.trim() === "") return [];

	const lines = body.split("\n");

	// Track the current heading section
	let currentHeading = "";
	const items: ChecklistItem[] = [];

	for (const line of lines) {
		// Detect headings
		const headingMatch = line.match(/^##\s+(.+)/i);
		if (headingMatch) {
			currentHeading = headingMatch[1]!.trim().toLowerCase();
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

// ─── Title Verb Extraction ──────────────────────────────────────────

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

// ─── Checklist Keyword Extraction ──────────────────────────────────

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

// ─── Diff Direction Classification ──────────────────────────────────

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

// ─── Diff Status Parsing ────────────────────────────────────────────

/**
 * Parse `git diff --name-status` output into structured entries.
 *
 * Each line has format: STATUS\tpath or STATUS\toldPath\tnewPath
 * Status letters: A (added), D (deleted), M (modified), R (renamed),
 * C (copied), etc.
 */
interface DiffEntry {
	status: string;
	path: string;
	oldPath?: string;
}

function parseDiffNameStatus(output: string): DiffEntry[] {
	if (!output || output.trim() === "") return [];

	const entries: DiffEntry[] = [];
	const lines = output.trim().split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Handle renames: R100\told\tnew
		const renameMatch = trimmed.match(/^(R\d+)\s+(.+?)\s+(.+)$/);
		if (renameMatch) {
			entries.push({
				status: renameMatch[1]!,
				path: renameMatch[3]!.trim(),
				oldPath: renameMatch[2]!.trim(),
			});
			continue;
		}

		// Handle simple: A/D/M\tpath
		const simpleMatch = trimmed.match(/^([ADM])\s+(.+)$/);
		if (simpleMatch) {
			entries.push({
				status: simpleMatch[1]!,
				path: simpleMatch[2]!.trim(),
			});
			continue;
		}
	}

	return entries;
}

// ─── Checklist Keyword Coverage Check ──────────────────────────────

/**
 * Check if keywords from checklist items appear in changed files.
 *
 * Uses the ExecFn to run `grep` for each keyword in each changed file.
 * A match is found if at least one keyword from a checklist item appears
 * in at least one changed file.
 *
 * @param exec - Exec function
 * @param worktreePath - Path to worktree
 * @param changedFiles - List of changed file paths
 * @param checklistKeywords - Keywords per checklist item
 * @returns Array of gaps (one per unmatched item)
 */
async function checkChecklistKeywordCoverage(
	exec: ExecFn,
	worktreePath: string,
	changedFiles: string[],
	checklistKeywords: ChecklistKeywords[],
): Promise<TraceabilityGap[]> {
	if (checklistKeywords.length === 0 || changedFiles.length === 0) return [];

	const gaps: TraceabilityGap[] = [];

	for (const entry of checklistKeywords) {
		if (entry.keywords.length === 0) continue;

		let found = false;

		// Check each keyword against each changed file via grep
		for (const keyword of entry.keywords) {
			for (const file of changedFiles) {
				try {
					const result = await exec("grep", ["-l", keyword, file], {
						cwd: worktreePath,
						timeout: 5_000,
					});
					if (result.code === 0) {
						found = true;
						break;
					}
				} catch {
					// grep failure is non-fatal
				}
			}
			if (found) break;
		}

		if (!found) {
			gaps.push({
				check: "checklist-keyword-coverage",
				severity: "warning",
				detail: `Checklist item "${entry.item}" — no keywords matched in changed files. Keywords checked: ${entry.keywords.join(", ")}`,
			});
		}
	}

	return gaps;
}

// ─── Test File Parity Check ────────────────────────────────────────

/**
 * Check that each changed source file has a corresponding test file.
 *
 * For each changed file that is testable (source code, not generated/vendor/barrel),
 * checks if a corresponding test file exists under test/ or tests/ directory.
 *
 * Mapping rules:
 * - src/foo.ts → test/foo.test.ts or tests/foo.test.ts
 * - src/foo.ts → test/foo.spec.ts or tests/foo.spec.ts
 * - src/sub/foo.ts → test/sub/foo.test.ts or tests/sub/foo.test.ts
 *
 * @param changedFiles - List of changed file paths
 * @param worktreePath - Path to worktree
 * @returns Array of gaps (one per missing test file)
 */
async function checkTestFileParity(
	changedFiles: string[],
	worktreePath: string,
): Promise<TraceabilityGap[]> {
	if (changedFiles.length === 0) return [];

	const gaps: TraceabilityGap[] = [];

	for (const file of changedFiles) {
		// Skip non-testable files (type declarations, generated, vendor, barrel)
		if (!isTestableFile(file)) continue;

		// Skip test files themselves
		if (file.includes(".test.") || file.includes(".spec.") || file.includes("__tests__/")) {
			continue;
		}

		// Derive expected test file paths
		const dir = dirname(file);
		const baseName = basename(file);
		const ext = extname(baseName);
		const nameWithoutExt = baseName.slice(0, -ext.length);

		// Try test/ and tests/ directories
		const testDirs = ["test", "tests"];
		const possibleTestFiles: string[] = [];

		for (const testDir of testDirs) {
			// Determine the relative subdirectory under test/
			// src/foo.ts → test/foo.test.ts (no subdir)
			// src/sub/foo.ts → test/sub/foo.test.ts (subdir preserved)
			// lib/foo.ts → test/lib/foo.test.ts (non-src dir preserved)
			let testSubDir = dir;
			// Strip leading "src" or "src/" prefix to mirror under test/
			if (testSubDir === "src") {
				testSubDir = "";
			} else if (testSubDir.startsWith("src/")) {
				testSubDir = testSubDir.slice(4);
			}
			const testRelDir = testSubDir ? testSubDir + "/" : "";

			possibleTestFiles.push(
				join(testDir, testRelDir, `${nameWithoutExt}.test.ts`),
				join(testDir, testRelDir, `${nameWithoutExt}.test.mts`),
				join(testDir, testRelDir, `${nameWithoutExt}.spec.ts`),
			);

			// Also check src-relative: src/foo.ts → test/foo.ts (directory mirror)
			possibleTestFiles.push(join(testDir, file.replace(/^src\//, "")));
		}

		// Check if any test file exists
		const testExists = possibleTestFiles.some((tf) => existsSync(join(worktreePath, tf)));

		if (!testExists) {
			gaps.push({
				check: "test-file-parity",
				severity: "warning",
				detail: `Source file "${file}" has no corresponding test file. Expected one of: ${possibleTestFiles.slice(0, 4).join(", ")}`,
			});
		}
	}

	return gaps;
}

// ─── Old Reference Cleanup Check ───────────────────────────────────

/**
 * Check that deleted/renamed files have no remaining references in the codebase.
 *
 * For each deleted file or renamed old-path, runs `git grep` on the remaining
 * codebase (at HEAD) for the old module name, import path, or function name.
 *
 * @param exec - Exec function
 * @param worktreePath - Path to worktree
 * @param diffEntries - Parsed diff entries
 * @returns Array of gaps (one per old reference found)
 */
async function checkOldReferenceCleanup(
	exec: ExecFn,
	worktreePath: string,
	diffEntries: DiffEntry[],
): Promise<TraceabilityGap[]> {
	if (diffEntries.length === 0) return [];

	// Collect old paths from deletions and renames
	const oldPaths: string[] = [];

	for (const entry of diffEntries) {
		if (entry.status === "D") {
			oldPaths.push(entry.path);
		}
		if (entry.status.startsWith("R") && entry.oldPath) {
			oldPaths.push(entry.oldPath);
		}
	}

	if (oldPaths.length === 0) return [];

	const gaps: TraceabilityGap[] = [];

	for (const oldPath of oldPaths) {
		// Extract the base name (without extension) for import reference checking
		const baseName = basename(oldPath);
		const nameWithoutExt = baseName.replace(/\.[^.]+$/, "");

		// Also extract module-like references: path segments, camelCase names
		const refPatterns = [nameWithoutExt, oldPath.replace(/^src\//, "")];

		for (const pattern of refPatterns) {
			try {
				const result = await exec("git", ["grep", "-l", pattern], {
					cwd: worktreePath,
					timeout: 10_000,
				});
				if (result.code === 0 && result.stdout.trim()) {
					const filesWithRefs = result.stdout.trim().split("\n").filter(Boolean);
					gaps.push({
						check: "old-reference-cleanup",
						severity: "warning",
						detail: `Deleted/renamed file "${oldPath}" still referenced in ${filesWithRefs.length} file(s): ${filesWithRefs.slice(0, 5).join(", ")}${filesWithRefs.length > 5 ? `... and ${filesWithRefs.length - 5} more` : ""}`,
					});
					break; // Only report once per old path
				}
			} catch {
				// grep failure is non-fatal
			}
		}
	}

	return gaps;
}

// ─── Title-Diff Direction Check ────────────────────────────────────

/**
 * Check that the diff direction matches the issue title imperative verb.
 *
 * For "add"/"implement"/"create" titles: expects net additions (A > D).
 * For "remove"/"delete"/"migrate" titles: expects net deletions (D > A).
 *
 * Warning-only: does not block transition.
 *
 * @param titleVerb - Extracted imperative verb
 * @param diffEntries - Parsed diff entries
 * @returns Array of gaps (at most one)
 */
function checkTitleDiffDirection(
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

// ─── Main Orchestration ────────────────────────────────────────────

/**
 * Run all requirements-traceability checks.
 *
 * Orchestrates 4 deterministic checks:
 * 1. Checklist keyword → diff coverage
 * 2. Test file parity
 * 3. Old reference cleanup
 * 4. Issue title → diff direction
 *
 * All checks are non-blocking. Results are surfaced to the auditor agent
 * as a structured gap list. The auditor decides severity.
 *
 * @param exec - Exec function (from pi.exec or mock)
 * @param worktreePath - Path to the worktree
 * @param defaultBranch - Default branch name (e.g. "main")
 * @param filteredData - Filtered issue data (body + comments)
 * @param issueTitle - Issue title
 * @returns Array of traceability gaps
 */
export async function runRequirementsTraceability(
	exec: ExecFn,
	worktreePath: string,
	defaultBranch: string,
	filteredData: FilteredIssueData,
	issueTitle: string,
): Promise<TraceabilityGap[]> {
	const gaps: TraceabilityGap[] = [];

	// Step 1: Get git diff information
	let diffEntries: DiffEntry[] = [];
	let changedFiles: string[] = [];

	try {
		const diffResult = await exec("git", ["diff", defaultBranch, "--name-status"], {
			cwd: worktreePath,
			timeout: 10_000,
		});

		if (diffResult.code === 0) {
			diffEntries = parseDiffNameStatus(diffResult.stdout);
			changedFiles = diffEntries.map((e) => e.path);

			// Also include old paths in changed files list for keyword search
			for (const entry of diffEntries) {
				if (entry.oldPath && !changedFiles.includes(entry.oldPath)) {
					changedFiles.push(entry.oldPath);
				}
			}
		} else {
			gaps.push({
				check: "diff",
				severity: "warning",
				detail: `git diff failed: ${diffResult.stderr || "unknown error"}`,
			});
			return gaps;
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		gaps.push({
			check: "diff",
			severity: "warning",
			detail: `git diff failed: ${msg}`,
		});
		return gaps;
	}

	// Step 2: Parse issue body
	const body = filteredData?.body || "";
	const title = issueTitle || "";

	// Step 3: Run checklist keyword coverage check
	try {
		const checklistItems = parseIssueBodyChecklists(body);
		if (checklistItems.length > 0) {
			const checklistKeywords = extractChecklistKeywords(checklistItems);
			const checklistGaps = await checkChecklistKeywordCoverage(
				exec,
				worktreePath,
				changedFiles,
				checklistKeywords,
			);
			gaps.push(...checklistGaps);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		gaps.push({
			check: "checklist-keyword-coverage",
			severity: "warning",
			detail: `Checklist keyword check failed: ${msg}`,
		});
	}

	// Step 4: Run test file parity check
	try {
		const testGaps = await checkTestFileParity(changedFiles, worktreePath);
		gaps.push(...testGaps);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		gaps.push({
			check: "test-file-parity",
			severity: "warning",
			detail: `Test file parity check failed: ${msg}`,
		});
	}

	// Step 5: Run old reference cleanup check
	try {
		const oldRefGaps = await checkOldReferenceCleanup(exec, worktreePath, diffEntries);
		gaps.push(...oldRefGaps);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		gaps.push({
			check: "old-reference-cleanup",
			severity: "warning",
			detail: `Old reference cleanup check failed: ${msg}`,
		});
	}

	// Step 6: Run title-diff direction check
	try {
		const titleVerb = extractTitleVerb(title);
		const dirGaps = checkTitleDiffDirection(titleVerb, title, diffEntries);
		gaps.push(...dirGaps);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		gaps.push({
			check: "title-diff-direction",
			severity: "warning",
			detail: `Title-diff direction check failed: ${msg}`,
		});
	}

	return gaps;
}
