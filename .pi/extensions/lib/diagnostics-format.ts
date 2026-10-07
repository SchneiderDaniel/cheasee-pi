/**
 * diagnostics-format.ts — Single home for diagnostic rendering.
 *
 * Owns the mechanics shared by every extension that renders a list of
 * diagnostics for humans: group by file, sort files alphabetically, sort
 * within a file, join blocks with one blank line, truncate long messages.
 *
 * Per-extension *policy* stays with the caller: sort precedence (severity
 * union) and per-line suffix text (code / ruleId) are passed in via
 * `FormatOptions<T>`.
 *
 * Layer: domain — zero pi/fs/lsp/eslint imports. Pure functions only.
 */

/** Minimum shape a diagnostic must expose to be rendered here. */
export interface FormattableDiagnostic {
	readonly file: string;
	readonly line: number;
	readonly column?: number;
	readonly severity: string;
	readonly message: string;
}

/** Per-caller policy. Defaults render line→column order with no suffix. */
export interface FormatOptions<T> {
	/** Ordering within a file. Default: line asc, then column asc. */
	compare?: (a: T, b: T) => number;
	/** Per-line suffix text (e.g. ` (TS2322)` or ` (@typescript-eslint/no-explicit-any)`). */
	suffix?: (d: T) => string;
	/** Max rendered message length before truncation. Default 500. */
	maxMessageLength?: number;
}

/**
 * Truncate a message to at most `max` characters (default 500), appending
 * "..." when truncated. UTF-16 slice semantics.
 */
export function truncateMessage(msg: string, max = 500): string {
	if (msg.length > max) return msg.slice(0, max - 3) + "...";
	return msg;
}

/**
 * Build a block of formatted diagnostic lines and append it to `blocks`,
 * separating consecutive blocks with exactly one blank line.
 */
export function pushLineBlock<T>(
	blocks: string[],
	diags: readonly T[],
	formatLine: (d: T) => string,
): void {
	const lines: string[] = [];
	for (const d of diags) {
		lines.push(formatLine(d));
	}
	if (blocks.length > 0) blocks.push("");
	blocks.push(lines.join("\n"));
}

/**
 * Render diagnostics into a compact, human-readable message.
 *
 * Generic renderer with full caller policy via `FormatOptions<T>`. Grouped by
 * file, files sorted alphabetically, blocks joined by a blank line, messages
 * truncated. The caller's input array is never reordered. Returns "" for
 * null, undefined, or empty input.
 */
export function renderDiagnostics<T extends FormattableDiagnostic>(
	diagnostics: readonly T[] | null | undefined,
	opts: FormatOptions<T> = {},
): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	const max = opts.maxMessageLength ?? 500;
	const compare =
		opts.compare ??
		((a: T, b: T) => (a.line !== b.line ? a.line - b.line : (a.column ?? 0) - (b.column ?? 0)));
	const suffix = opts.suffix;

	const byFile = new Map<string, T[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		diags.sort(compare);
		pushLineBlock(
			blocks,
			diags,
			(d) =>
				`${file}, Line ${d.line}: [${d.severity}] ${truncateMessage(d.message, max)}${suffix ? suffix(d) : ""}`,
		);
	}

	return blocks.join("\n");
}

/**
 * Convenience renderer with the default policy (line→column order, no suffix).
 * Thin facade over `renderDiagnostics`; callers needing a custom comparator or
 * per-line suffix call `renderDiagnostics` directly.
 */
export function formatDiagnostics(
	diagnostics: readonly FormattableDiagnostic[] | null | undefined,
): string {
	return renderDiagnostics(diagnostics);
}
