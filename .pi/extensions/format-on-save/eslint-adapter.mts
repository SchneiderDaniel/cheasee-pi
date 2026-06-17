/**
 * eslint-adapter.mts — EslintLinter adapter.
 *
 * Wraps the ESLint programmatic API behind the Linter port.
 * Uses `ESLint.lintText()` and `ESLint.outputFixes()` in-process instead
 * of subprocess CLI, eliminating JSON parsing and Node.js boot overhead.
 *
 * Lazy-initializes the ESLint instance on first `lint()` call (~100–500ms
 * for config parse), then reuses it for subsequent calls (~10–50ms each).
 *
 * ESLint availability: if ESLint is not installed, `lint()` returns an
 * error result gracefully instead of crashing.
 *
 * Dependency injection: the ESLint factory can be injected for testing
 * without requiring a real ESLint installation.
 */

import type { Diagnostic, LintResult } from "./ports.mts";
import type { Linter } from "./ports.mts";

// ─── Supported File Extensions ────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

// ─── ESLint Result Types ──────────────────────────────────────────────

/** A single message from ESLint result. */
interface ESLintMessage {
	line: number;
	column: number;
	severity: number;
	message: string;
	ruleId: string | null;
}

/** ESLint lint result for one file. */
interface ESLintFileResult {
	messages: ESLintMessage[];
	filePath: string;
	output?: string;
	fix?: unknown;
}

/** Minimal ESLint-like interface for DI. */
export interface ESLintInstance {
	lintText(text: string, options: { filePath: string }): Promise<ESLintFileResult[]>;
}

/** Factory type for creating an ESLint instance. */
export type ESLintFactory = () => Promise<ESLintInstance>;

// ─── Default Factory (lazy dynamic import) ────────────────────────────

const defaultCreateESLint: ESLintFactory = async () => {
	// Dynamic import: ESLint may not be installed.
	// The call site wraps this in a try/catch and returns an error result gracefully.
	// @ts-expect-error -- eslint may not be installed; handled at runtime
	const { ESLint } = await import("eslint");
	const instance = new ESLint({ fix: true }) as unknown as ESLintInstance;
	return instance;
};

// ─── EslintLinter ─────────────────────────────────────────────────────

/**
 * EslintLinter — adapts the ESLint programmatic API to the Linter port.
 *
 * Lazily creates an ESLint instance on first `lint()` call and reuses it.
 * If ESLint is not installed, returns an error result gracefully.
 *
 * @example
 * ```ts
 * const linter = new EslintLinter();
 * const result = await linter.lint("/repo/src/app.ts");
 * ```
 */
export class EslintLinter implements Linter {
	private readonly createESLint: ESLintFactory;
	private eslintPromise: Promise<ESLintInstance> | null = null;
	private initError: string | null = null;

	/**
	 * @param createESLint Factory for creating an ESLint instance.
	 *   Default: dynamic import of `eslint` package.
	 */
	constructor(createESLint: ESLintFactory = defaultCreateESLint) {
		this.createESLint = createESLint;
	}

	/** @inheritdoc */
	canHandle(path: string): boolean {
		const lower = path.toLowerCase();
		return (SUPPORTED_EXTENSIONS as readonly string[]).some((ext) => lower.endsWith(ext));
	}

	/** @inheritdoc */
	async lint(path: string): Promise<LintResult> {
		try {
			const eslint = await this.getESLint();
			const source = await this.readFile(path);

			// Primary attempt: lint with fix
			let results = await eslint.lintText(source, { filePath: path });

			// Check if we got results
			if (!results || results.length === 0) {
				return { diagnostics: [], fixesApplied: false };
			}

			const fileResult = results[0]!;
			const diagnostics = this.mapMessages(fileResult);
			const fixesApplied = this.hasFixes(fileResult);

			// Write fixes if any were applied
			if (fixesApplied && fileResult.output) {
				await this.writeFile(path, fileResult.output);
			}

			return { diagnostics, fixesApplied };
		} catch (err) {
			const message = this.getErrorMessage(err);

			// Config error — retry with minimal config
			if (this.isConfigError(err)) {
				try {
					const fallbackResult = await this.lintWithFallback(path);
					// Surface the original config error so the handler can log it
					fallbackResult.error = this.getErrorMessage(err);
					return fallbackResult;
				} catch (fallbackErr) {
					return {
						diagnostics: [],
						fixesApplied: false,
						error: this.getErrorMessage(fallbackErr),
					};
				}
			}

			return { diagnostics: [], fixesApplied: false, error: message };
		}
	}

	/**
	 * Retry linting with a fallback ESLint instance (no project config).
	 * Mirrors the current `tryRunEslint` retry logic with `--no-eslintrc`.
	 */
	private async lintWithFallback(path: string): Promise<LintResult> {
		// Create a fresh ESLint instance with empty/minimal config
		const fallbackESLint = await this.createFallbackESLint();
		const source = await this.readFile(path);
		const results = await fallbackESLint.lintText(source, {
			filePath: path,
		});

		if (!results || results.length === 0) {
			return { diagnostics: [], fixesApplied: false };
		}

		const fileResult = results[0]!;
		const diagnostics = this.mapMessages(fileResult);

		return { diagnostics, fixesApplied: false };
	}

	/**
	 * Read file contents. Uses a simple fs.readFile in the real adapter.
	 */
	private async readFile(path: string): Promise<string> {
		const { readFile } = await import("node:fs/promises");
		return readFile(path, "utf-8");
	}

	/**
	 * Write file contents.
	 */
	private async writeFile(path: string, content: string): Promise<void> {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path, content, "utf-8");
	}

	/**
	 * Get or create the ESLint instance.
	 */
	private async getESLint(): Promise<ESLintInstance> {
		if (this.initError) {
			throw new Error(this.initError);
		}
		this.eslintPromise ??= this.createESLint().catch((err) => {
			this.initError = err instanceof Error ? err.message : String(err);
			throw err;
		});
		return this.eslintPromise;
	}

	/**
	 * Create a fallback ESLint instance with no project config.
	 */
	private async createFallbackESLint(): Promise<ESLintInstance> {
		// @ts-expect-error -- eslint may not be installed; handled at runtime
		const { ESLint } = await import("eslint");
		const instance = new ESLint({
			useEslintrc: false,
		}) as unknown as ESLintInstance;
		return instance;
	}

	/**
	 * Map ESLint's LintResult.messages to our Diagnostic type.
	 *   severity 2 → Error, severity 1 → Warning
	 */
	private mapMessages(result: ESLintFileResult): Diagnostic[] {
		return result.messages.map((msg) => ({
			file: result.filePath,
			line: msg.line || 0,
			column: msg.column || 0,
			severity: msg.severity === 2 ? "Error" : "Warning",
			message: msg.message || "",
			ruleId: msg.ruleId || null,
		}));
	}

	/**
	 * Check if ESLint result has fixes applied (output differs from input).
	 */
	private hasFixes(result: ESLintFileResult): boolean {
		return !!result.output || !!result.fix;
	}

	/**
	 * Extract a human-readable message from an unknown error value.
	 * Handles Error instances, plain objects with a `message` property, and
	 * any other value via String().
	 */
	private getErrorMessage(err: unknown): string {
		if (err instanceof Error) return err.message;
		const msg = (err as { message?: unknown } | null)?.message;
		if (typeof msg === "string") return msg;
		return String(err);
	}

	/**
	 * Check if the error is a config-related error that warrants fallback.
	 *
	 * Two-tier check:
	 *   1. `error.name === "ConfigError"` — precise for ESLint v9+ flat config
	 *   2. Keyword matching — fallback for legacy eslintrc error formats
	 */
	private isConfigError(err: unknown): boolean {
		// Tier 1: precise name check for ESLint v9+ flat config ConfigError
		const name = (err as { name?: string } | null)?.name;
		if (name === "ConfigError") {
			return true;
		}
		// Tier 2: keyword fallback for legacy eslintrc error formats
		const msg = this.getErrorMessage(err);
		return (
			msg.includes("config") ||
			msg.includes("Config") ||
			msg.includes(".eslintrc") ||
			msg.includes("eslint.config") ||
			msg.includes("configuration") ||
			msg.includes("Could not find") ||
			msg.includes("Failed to load")
		);
	}
}
