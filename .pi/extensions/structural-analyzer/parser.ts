/**
 * parser.ts — NDJSON output parsing and exec result interpretation for structural-analyzer.
 *
 * Parses ast-grep's --json=stream output (one JSON object per line).
 * Interprets exec results using exit-code-based logic:
 *   - code 0 = success (stdout may contain JSONL matches or be empty)
 *   - code 1 = no matches found (empty stdout, empty stderr)
 *   - all other non-zero codes = real errors
 *
 * When stderr is non-empty with any exit code, it's treated as an error
 * (exit code 1 with non-empty stderr means ast-grep encountered an issue).
 *
 * NOTE: truncateSnippet uses String.slice(0, 119) which operates on UTF-16
 * code units, not code points. Characters outside the Basic Multilingual Plane
 * (e.g., emoji) could be mis-split. This is a documented limitation — the
 * codebase currently does not contain grapheme cluster characters in snippets.
 */

import type { SgMatch, SgResult, ExecResultResponse } from "./types.ts";

/** Maximum results to return inline before truncating for streaming. */
export const STREAM_THRESHOLD = 100;

/**
 * Interpret the result of an ast-grep exec call and return the appropriate
 * response shape based on exit code, stdout, and stderr.
 *
 * Replaces the fragile keyword-heuristic error detection with exit-code-based logic.
 */
export function interpretSgExecResult(
	code: number,
	stdout: string,
	stderr: string,
	pattern: string,
	language: string,
): ExecResultResponse {
	const trimmedStdout = (stdout || "").trim();
	const trimmedStderr = (stderr || "").trim();

	// If there's actual stdout content, parse it regardless of exit code
	// (ast-grep may produce partial results even on non-zero exit)
	if (trimmedStdout.length > 0) {
		const sgResult = parseSgOutput(stdout);

		// Check streaming threshold — truncate if too many matches
		if (sgResult.matches > STREAM_THRESHOLD) {
			const truncatedResults = sgResult.results.slice(0, STREAM_THRESHOLD);
			const summary: SgResult = {
				matches: sgResult.matches,
				results: truncatedResults,
			};
			const json = JSON.stringify(summary, null, 2);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Structural search results for pattern: ${pattern}\n` +
							`Language: ${language}\n` +
							`Matches: ${sgResult.matches} (showing first ${STREAM_THRESHOLD})\n\n` +
							"```json\n" +
							json +
							"\n```\n\n" +
							`Results truncated to ${STREAM_THRESHOLD}. Total matches: ${sgResult.matches}. ` +
							`Refine the search pattern to narrow results.`,
					},
				],
				details: {
					success: true,
					matches: sgResult.matches,
					results: truncatedResults,
					truncated: true,
					totalMatches: sgResult.matches,
				} as Record<string, unknown>,
			};
		}

		const json = JSON.stringify(sgResult, null, 2);
		return {
			content: [
				{
					type: "text" as const,
					text:
						`Structural search results for pattern: ${pattern}\n` +
						`Language: ${language}\n` +
						`Matches: ${sgResult.matches}\n\n` +
						"```json\n" +
						json +
						"\n```",
				},
			],
			details: { success: true, ...sgResult } as Record<string, unknown>,
		};
	}

	// No stdout content
	if (code === 0) {
		// ast-grep succeeded but produced no output
		return {
			content: [
				{
					type: "text" as const,
					text: `No matches found for pattern "${pattern}" in language "${language}".`,
				},
			],
			details: { success: true, matches: 0, results: [] } as Record<string, unknown>,
		};
	}

	// Exit code 1 with empty stderr = legitimate no-match (ast-grep convention)
	if (code === 1 && trimmedStderr.length === 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: `No matches found for pattern "${pattern}" in language "${language}".`,
				},
			],
			details: { success: true, matches: 0, results: [] } as Record<string, unknown>,
		};
	}

	// Everything else is a real error
	const stderrMsg = trimmedStderr || "(no stderr)";
	return {
		content: [
			{
				type: "text" as const,
				text: `ast-grep failed (exit code ${code}): ${stderrMsg}`,
			},
		],
		details: {
			success: false,
			exitCode: code,
			stderr: stderr,
		} as Record<string, unknown>,
		isError: true,
	};
}

/**
 * Truncate a snippet to 120 characters.
 * If the string exceeds 120 chars, truncate to 119 chars and append '…' (120 total).
 *
 * NOTE: Uses String.slice() operating on UTF-16 code units, not code points.
 * Characters outside the BMP (emoji, etc.) may be mis-split. This is a
 * documented limitation — see module docstring for details.
 */
export function truncateSnippet(text: string): string {
	if (!text) return "";
	if (text.length <= 120) return text;
	return text.slice(0, 119) + "…";
}

/**
 * Parse raw ast-grep JSONL output into SgResult.
 *
 * ast-grep --json=stream outputs one JSON object per line (NDJSON).
 * Empty lines, malformed JSON lines, or lines missing required fields are skipped.
 */
export function parseSgOutput(raw: string): SgResult {
	if (!raw || typeof raw !== "string") {
		return { matches: 0, results: [] };
	}

	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const results: SgMatch[] = [];

	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // skip malformed lines
		}

		if (typeof parsed !== "object" || parsed === null) continue;

		const tag = parsed as Record<string, unknown>;

		// Must have file, text, and lines fields
		if (typeof tag.file !== "string" || !tag.file) continue;
		if (typeof tag.text !== "string") continue;
		if (typeof tag.lines !== "string" && typeof tag.lines !== "number") continue;

		const linesStr = typeof tag.lines === "number" ? String(tag.lines) : (tag.lines as string);

		results.push({
			file: tag.file,
			lines: linesStr,
			snippet: truncateSnippet(tag.text),
		});
	}

	return {
		matches: results.length,
		results,
	};
}
