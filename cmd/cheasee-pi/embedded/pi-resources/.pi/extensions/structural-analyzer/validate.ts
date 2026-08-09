/**
 * validate.ts — Pattern validation for structural-analyzer.
 *
 * Validates that a pattern is suitable for ast-grep (structural/syntax-aware
 * search) rather than plain text search.
 *
 * Collision rule:
 * - Empty or whitespace-only strings are rejected
 * - Single words without structural syntax (no `{`, `$`, `(`, `[`) are
 *   rejected — the agent should use ripgrep for text patterns like "TODO"
 *
 * Returns null if valid, or an error string if invalid.
 */

/**
 * Validate that a pattern is suitable for ast-grep structural search.
 * Returns null if valid, or an error string if invalid.
 */
export function validatePattern(pattern: string): string | null {
	if (!pattern || typeof pattern !== "string") {
		return "Pattern must be a non-empty string";
	}

	const trimmed = pattern.trim();
	if (!trimmed) {
		return "Pattern must be a non-empty string";
	}

	// Structural syntax characters that indicate AST-aware search intent
	const structuralSyntax = /[{$(\\[\]]/;

	// If the pattern is a single word (no whitespace, no structural syntax), reject it
	const isSingleWord = /^\S+$/.test(trimmed);

	if (isSingleWord && !structuralSyntax.test(trimmed)) {
		return `Pattern "${trimmed}" is a single-word text pattern without structural syntax. Use ripgrep (ripgrep_search) for text-based search instead of ast-grep.`;
	}

	return null;
}
