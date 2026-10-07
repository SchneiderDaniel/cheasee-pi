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
// shared output parser (backends differ only in regex + capture adapter)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Backend-specific capture adapter: turn one regex match into the fields that
 * both backends share. `file` (capture group 1) is assembled by `parseMatches`.
 * Return null to skip the line without counting it (malformed/non-numeric).
 */
type MatchAdapter = (m: RegExpMatchArray) => Omit<RgMatch, "file"> | null;

/** Parse captured digits to an integer, or null when not numeric. */
function toIntOrNull(s: string): number | null {
	const n = parseInt(s, 10);
	return Number.isNaN(n) ? null : n;
}

/**
 * Single authority for both backends' line parsing: empty guard, line split,
 * blank/regex skip, uncapped `total_returned` counting, `maxResults` cap and
 * the `RgResult` shape. A backend supplies only its regex and capture adapter,
 * so truncation accounting cannot drift between the primary and fallback path.
 */
function parseMatches(
	raw: string | null | undefined,
	maxResults: number,
	regex: RegExp,
	adapt: MatchAdapter,
): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];
	let totalMatches = 0;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(regex);
		if (!match) continue;

		const rest = adapt(match);
		if (!rest) continue;

		totalMatches++;

		if (results.length < maxResults) {
			results.push({ file: match[1]!, ...rest });
		}
	}

	return {
		total_returned: totalMatches,
		results,
		truncated: totalMatches > maxResults,
	};
}

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
	return parseMatches(raw, maxResults, /^(.+?):(\d+):(\d+):(.*)$/, (m) => {
		const line = toIntOrNull(m[2]!);
		const column = toIntOrNull(m[3]!);
		if (line === null || column === null) return null;
		return { line, column, text: m[4]! };
	});
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
 *
 * Thin wrapper over `parseMatches`; the shared loop owns the truncation
 * accounting and result shape, so any new RgMatch field must be set there (or
 * in the adapter below) to reach both backends.
 */
export function parseGrepOutput(
	raw: string | null | undefined,
	maxResults: number = Infinity,
): RgResult {
	return parseMatches(raw, maxResults, /^(.+?):(\d+):(.*)$/, (m) => {
		const line = toIntOrNull(m[2]!);
		if (line === null) return null;
		return { line, column: 1, text: m[3]! };
	});
}
