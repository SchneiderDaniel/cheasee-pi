/**
 * renderer/parse.ts — JSONL session file loading (data-source adapter).
 *
 * Hides readFileSync + line format. Shared by the markdown renderer and the
 * stats walk. Must NOT swallow JSON.parse throws — the caller's try/catch
 * (report.ts) owns that error path.
 */

import { readFileSync } from "node:fs";

/**
 * Read and parse a .jsonl session file.
 *
 * @returns `{ entries }` for a non-empty file, or `null` for empty /
 * whitespace-only content. A missing file propagates ENOENT; a malformed
 * line propagates the JSON.parse SyntaxError.
 */
export function loadSessionEntries(filepath: string): { entries: any[] } | null {
	const raw = readFileSync(filepath, "utf-8").trim();
	if (!raw) return null;

	const entries = raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	if (entries.length === 0) return null;

	return { entries };
}
