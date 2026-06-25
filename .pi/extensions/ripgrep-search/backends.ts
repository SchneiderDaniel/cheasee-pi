/**
 * Backend-specific CLI argument builders and output parsers for
 * ripgrep and grep search backends.
 *
 * Pure functions — no dependencies on pi SDK or other modules (except types.ts).
 * Query and directory are always passed as separate array elements
 * to prevent shell injection.
 *
 * Merged from args.ts + parse.ts: backend lifecycle (build args + parse output)
 * lives in one module. See #1078.
 */

import type { RgMatch, RgResult } from "./types.ts";

// ═══════════════════════════════════════════════════════════════════════
// ripgrep backend
// ═══════════════════════════════════════════════════════════════════════

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
 * Parse raw ripgrep --vimgrep output into RgResult.
 *
 * --vimgrep output format: file:line:column:text
 * Parsed with regex: ^(.+?):(\d+):(\d+):(.*)$
 *
 * Empty input, null, undefined → empty result.
 * Malformed lines (missing colons, non-numeric line/column) → skipped.
 * Lines with colons in the text portion → text is everything after third colon.
 */
export function parseVimgrepOutput(
	raw: string | null | undefined,
	maxResults: number = Infinity,
): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];
	let totalMatches = 0;

	const vimgrepRegex = /^(.+?):(\d+):(\d+):(.*)$/;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(vimgrepRegex);
		if (!match) continue;

		const lineNum = parseInt(match[2]!, 10);
		const column = parseInt(match[3]!, 10);
		if (isNaN(lineNum) || isNaN(column)) continue;

		totalMatches++;

		if (results.length < maxResults) {
			const file = match[1]!;
			const text = match[4]!;
			results.push({
				file,
				line: lineNum,
				column,
				text,
			});
		}
	}

	return {
		total_returned: totalMatches,
		results,
		truncated: totalMatches > maxResults,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// grep backend
// ═══════════════════════════════════════════════════════════════════════

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

/**
 * Parse generic grep -rnH output into RgResult.
 * grep -rnH produces: file:line:text
 * Since grep lacks column info,
 * column defaults to 1.
 */
export function parseGrepOutput(
	raw: string | null | undefined,
	maxResults: number = Infinity,
): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];
	let totalMatches = 0;

	// grep -rnH: file:line:text
	// Text may contain colons, so match greedily from start
	const grepRegex = /^(.+?):(\d+):(.*)$/;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(grepRegex);
		if (!match) continue;

		const lineNum = parseInt(match[2]!, 10);
		if (isNaN(lineNum)) continue;

		totalMatches++;

		if (results.length < maxResults) {
			const file = match[1]!;
			const text = match[3]!;
			results.push({
				file,
				line: lineNum,
				column: 1,
				text,
			});
		}
	}

	return {
		total_returned: totalMatches,
		results,
		truncated: totalMatches > maxResults,
	};
}
