// ─── Scope Enforcement ───────────────────────────────────────────
// Pure functions for scope derivation and file-scope checking.
// Core domain logic: no pi/ctx/git/gh dependencies.
// Path normalization prevents CVE #6631 relative-path bypass.

import path from "node:path";

// ─── Scope Mapping ───────────────────────────────────────────────
// Maps issue labels to scope paths. Extension labels map to their
// directory under .pi/extensions/; "documentation" maps to *.md.

const SCOPE_MAP: Record<string, string> = {
	"agent-harness": ".pi/extensions/agent-harness/",
	"context-info": ".pi/extensions/context-info/",
	supervisor: ".pi/extensions/supervisor/",
	documentation: "*.md",
};

/**
 * Derive a scope path from issue labels.
 *
 * Rules:
 * - First matching label wins (multi-label issues simplified)
 * - Predefined labels (agent-harness, context-info, supervisor, documentation)
 *   are checked first via SCOPE_MAP
 * - Extension labels match on extensionDirs list
 * - No matching label → returns null (no restriction, backward compat)
 *
 * @param labels - Issue label names (case-insensitive matched)
 * @param extensionDirs - List of extension directory names under .pi/extensions/
 * @returns scope path string, or null for no restriction
 */
export function deriveScopeFromLabels(labels: string[], extensionDirs: string[]): string | null {
	if (!labels || labels.length === 0) return null;

	for (const rawLabel of labels) {
		const label = rawLabel.toLowerCase().trim();

		// Check predefined scope map first
		const mappedScope = SCOPE_MAP[label];
		if (mappedScope) return mappedScope;

		// Check if label matches an extension directory name
		if (extensionDirs.includes(label)) {
			return `.pi/extensions/${label}/`;
		}
	}

	return null;
}

/**
 * Check whether a file path falls within a scope boundary.
 *
 * Rules:
 * - null scope → true (no restriction, backward compat)
 * - Empty file path → false
 * - "*.md" scope → checks .md extension
 * - Path normalization via path.resolve() prevents CVE #6631
 *   relative-path alternation bypass (e.g. "../../outside/file.ts")
 * - Trailing-separator prefix matching prevents sibling directory
 *   prefix collisions (e.g. "supervisor-backup/x.ts" vs "supervisor/")
 *
 * @param file - File path from git diff (relative to repo root)
 * @param scope - Scope path or null (no restriction)
 * @returns true if the file is within scope
 */
export function isInScope(file: string, scope: string | null): boolean {
	if (scope === null) return true;
	if (!file) return false;

	// Handle documentation scope — match by .md extension (case-insensitive)
	if (scope === "*.md") {
		return file.toLowerCase().endsWith(".md");
	}

	// Normalize paths to resolve relative segments (CVE #6631 fix)
	// path.resolve("/", relativePath) makes the path absolute and
	// resolves any ".." or "." segments, preventing path alternation bypass
	const normalizedFile = path.resolve("/", file);
	const normalizedScope = path.resolve("/", scope);

	// Ensure trailing slash on both for prefix matching
	// This prevents sibling prefix collisions:
	//   scope ".pi/extensions/supervisor" won't match ".pi/extensions/supervisor-backup/"
	// because resolved paths "/.pi/extensions/supervisor/" won't prefix-match
	// "/.pi/extensions/supervisor-backup/x.ts/"
	const fileCheck = normalizedFile.endsWith("/") ? normalizedFile : normalizedFile + "/";
	const scopeCheck = normalizedScope.endsWith("/") ? normalizedScope : normalizedScope + "/";

	return fileCheck.startsWith(scopeCheck);
}
