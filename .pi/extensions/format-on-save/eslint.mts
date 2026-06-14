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
 */
export function formatEslintDiagnostics(diagnostics: Diagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	const byFile = new Map<string, Diagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		// Sort: errors first, then by line
		diags.sort((a, b) => {
			if (a.severity !== b.severity) return a.severity === "Error" ? -1 : 1;
			if (a.line !== b.line) return a.line - b.line;
			return a.column - b.column;
		});

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const rulePart = d.ruleId ? ` (${d.ruleId})` : "";
			lines.push(`${d.file}, Line ${d.line}: [${d.severity}] ${msg}${rulePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}
