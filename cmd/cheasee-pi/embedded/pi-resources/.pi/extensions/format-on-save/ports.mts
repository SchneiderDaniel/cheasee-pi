/**
 * ports.mts — Domain interfaces for format-on-save extension.
 *
 * Zero external dependencies. Pure TypeScript types owned by inner policy.
 *
 * Exports:
 *   Formatter — port for code formatting backends (Prettier, Biome, etc.)
 *   Linter    — port for linting backends (ESLint, Biome, etc.)
 *   FormatResult, LintResult, Diagnostic — value types
 */

// ─── Value Types ──────────────────────────────────────────────────────

/** Result of a format operation. */
export interface FormatResult {
	/** Whether the file was actually formatted (false = no change needed). */
	formatted: boolean;
	/** Error message if formatting failed. Undefined on success. */
	error?: string;
}

/** Result of a lint operation. */
export interface LintResult {
	/** Diagnostics found during linting. Empty array if no issues. */
	diagnostics: Diagnostic[];
	/** Whether any auto-fixes were applied. */
	fixesApplied: boolean;
	/** Error message if linting failed. Undefined on success. */
	error?: string;
}

/** A single diagnostic issue found by a linter. */
export interface Diagnostic {
	/** Absolute path to the file containing the issue. */
	file: string;
	/** Line number (1-based). */
	line: number;
	/** Column number (1-based). */
	column: number;
	/** Severity level. */
	severity: "Error" | "Warning";
	/** Human-readable description of the issue. */
	message: string;
	/** Rule ID that triggered this diagnostic, or null if not applicable. */
	ruleId: string | null;
}

// ─── Ports ────────────────────────────────────────────────────────────

/**
 * Formatter port — formats source code files.
 *
 * Implementations: PrettierFormatter, BiomeFormatter (future).
 * Tests: mock adapter implementing Formatter.
 */
export interface Formatter {
	/** Check if this formatter can handle the given file path. */
	canHandle(path: string): boolean;
	/** Format the file at the given path. Returns result after writing. */
	format(path: string): Promise<FormatResult>;
}

/**
 * Linter port — lints source code files and returns diagnostics.
 *
 * Implementations: EslintLinter, BiomeLinter (future).
 * Tests: mock adapter implementing Linter.
 */
export interface Linter {
	/** Check if this linter can handle the given file path. */
	canHandle(path: string): boolean;
	/** Lint the file at the given path. Returns diagnostics. */
	lint(path: string): Promise<LintResult>;
}
