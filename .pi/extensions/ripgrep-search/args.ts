/**
 * CLI argument builders for ripgrep and grep search backends.
 *
 * Pure functions — no dependencies on pi SDK or other modules.
 * Query and directory are always passed as separate array elements
 * to prevent shell injection.
 */

/**
 * Build ripgrep command arguments for a text search.
 *
 * Uses --vimgrep for machine-parseable output (file:line:column:text).
 * Uses --max-columns=200 to cap line length (prevents context-window blowup).
 * Uses --max-count to cap matches per file.
 * Uses --no-heading (implied by --vimgrep, explicit for safety).
 * Uses -j1 (single thread) to avoid per-thread output buffering memory blowup
 *   with --vimgrep (research finding: --vimgrep + parallelism can consume 18+ GB).
 *
 * Query and directory are passed as separate array elements — never
 * concatenated into the arg string — to prevent shell injection.
 */
export function buildRgArgs(
	query: string,
	directory: string,
	maxCount: number,
	maxLineLength: number = 200,
): { command: string; args: string[] } {
	const args = [
		"--vimgrep",
		`--max-columns=${maxLineLength}`,
		`--max-count=${maxCount}`,
		"--no-heading",
		"-j1",
		"--hidden",
		"--glob",
		"!.git/**",
		query,
		directory,
	];
	return { command: "rg", args };
}

/**
 * Build grep command arguments as fallback when ripgrep unavailable.
 * Emulates --vimgrep output (file:line:column:text) as closely as possible.
 * Column is set to 1 since standard grep doesn't output column.
 *
 * Excludes cache/ and .cache/ dirs to prevent context-window blowup from
 * large single-line cache files (e.g. cache-index.json at 21MB).
 */
export function buildGrepArgs(
	query: string,
	directory: string,
	maxCount: number,
): { command: string; args: string[] } {
	const excludedDirs = [
		"--exclude-dir=.git",
		"--exclude-dir=node_modules",
		"--exclude-dir=venv",
		"--exclude-dir=__pycache__",
		"--exclude-dir=.mypy_cache",
		"--exclude-dir=.pytest_cache",
		"--exclude-dir=dist",
		"--exclude-dir=build",
		"--exclude-dir=cache",
		"--exclude-dir=.cache",
	];
	const args = [
		"-rnH", // recursive, line-number, with-filename
		"-m",
		`${maxCount}`, // max matches per file
		"--color=never",
		...excludedDirs,
		"-e",
		query, // pattern (safe: separate arg, no injection)
		directory,
	];
	return { command: "grep", args };
}
