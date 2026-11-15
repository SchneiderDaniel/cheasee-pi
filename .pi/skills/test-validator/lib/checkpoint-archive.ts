// Adapter: `--restart` archives the previous checkpoint instead of deleting it.
//
// A rerun against changed fingerprints is allowed to supersede the old file, but
// the old decision history is evidence: it moves to `archive/<timestamp>.jsonl`
// under the same directory, and nothing is ever removed.

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/** Filesystem-safe archive name derived from the injected clock. */
function archiveStamp(now: Date): string {
	return `${now.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Move `path` aside when it holds records.
 *
 * @returns the archive path, or null when there was nothing to archive
 */
export function archivePrevious(path: string, now: Date): string | null {
	if (!existsSync(path) || readFileSync(path, "utf8") === "") return null;
	const archivePath = join(dirname(path), "archive", `${archiveStamp(now)}.jsonl`);
	mkdirSync(dirname(archivePath), { recursive: true });
	renameSync(path, archivePath);
	return archivePath;
}
