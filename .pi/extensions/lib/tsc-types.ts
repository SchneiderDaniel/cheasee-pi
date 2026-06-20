/**
 * tsc-types.ts — Shared TypeScript type-check types and formatter.
 *
 * Extracted from tsc-checkpoint/index.ts. Decision logic migrated to
 * supervisor/checks/audit-gate-decision.ts.
 * to eliminate the cross-extension direct import from supervisor → tsc-checkpoint.
 *
 * Layer: domain — zero pi dependencies. Pure types + one pure format function.
 */

// ── Types ──

/** A single TypeScript diagnostic from tsc compilation. */
export interface TscDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error";
	message: string;
	code?: string;
	/** Absolute path to the file (resolved from tsconfig dir). */
	filePath: string;
}

/** Result from a tsc checkpoint run (one-shot or watch). */
export interface TscCheckpointResult {
	diagnostics: TscDiagnostic[];
	hasErrors: boolean;
}

/** Decision output for the pipeline supervisor. */
export interface TscCheckpointDecision {
	nextStatus: string;
	note: string;
	tscTriggered: boolean;
}

// ── Formatter ──

/**
 * Format TSC diagnostics into a developer-readable message.
 *
 * Groups diagnostics by file, sorts files alphabetically, sorts
 * diagnostics by line then column within each file.
 * Truncates individual messages longer than 500 characters.
 *
 * Format per line: `file, Line N: [Error] message (code)`
 */
export function formatTscDiagnostics(diagnostics: TscDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	const byFile = new Map<string, TscDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		diags.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column));

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const codePart = d.code ? ` (${d.code})` : "";
			lines.push(`${d.file}, Line ${d.line}: [${d.severity}] ${msg}${codePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}
