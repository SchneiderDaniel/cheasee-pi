/**
 * eslint.mts — ESLint presentation utility.
 *
 * Kept: formatEslintDiagnostics — formats Diagnostic[] into a
 * developer-readable follow-up message string.
 *
 * Removed: parseEslintOutput, runEslintOnFile, tryRunEslint, ExecFn,
 * EslintDiagnostic — replaced by ESLint adapter + ports types.
 */

import type { Diagnostic } from "./ports.mts";
import { renderDiagnostics } from "../lib/diagnostics-format.ts";

/**
 * Format ESLint diagnostics into developer-readable follow-up message.
 *
 * @param diagnostics — Array of Diagnostic objects from linter.lint().
 * @returns Formatted string, or empty string if no diagnostics.
 *
 * Format per diagnostic:
 *   "<file>, Line <N>: [<severity>] <message> (<ruleId>)"
 *
 * Sorting: errors before warnings, then by line, then by column.
 * Grouping: by file, files sorted alphabetically, blank line between files.
 * Truncation: messages over 500 chars are truncated to 497 + "...".
 *
 * Mechanics live in the shared renderer (lib/diagnostics-format.ts); this
 * module owns only the eslint-specific severity comparator and ruleId suffix.
 */
export function formatEslintDiagnostics(diagnostics: Diagnostic[]): string {
	return renderDiagnostics(diagnostics, {
		compare: (a, b) => {
			if (a.severity !== b.severity) return a.severity === "Error" ? -1 : 1;
			if (a.line !== b.line) return a.line - b.line;
			return a.column - b.column;
		},
		suffix: (d) => (d.ruleId ? ` (${d.ruleId})` : ""),
	});
}
