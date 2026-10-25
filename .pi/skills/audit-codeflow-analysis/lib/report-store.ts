// ─── Report artifact store ──────────────────────────────────────
// The filesystem half of the transport: exclusive atomic writes, symlink
// containment, stale-artifact removal and the JSON-only markdown placeholder.
// Split out of fetch-report.ts (issue #2033): this module is the only place in
// the skill that writes report bytes, so the use case stops owning fs policy.

import {
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isPathWithinBase } from "../../../extensions/lib/path-containment.ts";
import { REPORT_JSON_REL_PATH } from "./report-paths.ts";
import type { WriteFileFn } from "./report-types.ts";

/**
 * `O_CREAT|O_EXCL`: fail rather than open an existing path (so a pre-planted
 * symlink at the temp path can never be followed). `O_NOFOLLOW` is belt and
 * braces for the same component.
 */
const EXCLUSIVE_WRITE_FLAGS =
	constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

export const defaultWriteFile: WriteFileFn = (path, data) => {
	const fd = openSync(path, EXCLUSIVE_WRITE_FLAGS, 0o600);
	try {
		for (let offset = 0; offset < data.length;) {
			const n = writeSync(fd, data, offset, data.length - offset);
			if (n <= 0) throw new Error(`Short write to ${path} (${offset}/${data.length} bytes)`);
			offset += n;
		}
	} finally {
		closeSync(fd);
	}
};

/** Decode report bytes as UTF-8 for content classification. */
export function decodeBody(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/**
 * Markdown narration for a JSON-only recovery: a pre-#1976 shim serves the
 * structured export on the markdown route, so there is no markdown report to
 * persist. `path` must still point at a readable markdown file (Step 1 of the
 * skill reads it), so write a short placeholder that redirects the reader to
 * the authoritative JSON artifact instead of leaving `path` dangling.
 */
export function renderRecoveredMarkdown(analyzedAt: number | null): Uint8Array {
	const when = analyzedAt === null ? "unknown" : new Date(analyzedAt).toISOString();
	return new TextEncoder().encode(
		"# CodeFlow Analysis Report\n\n" +
			"> **JSON-only recovery.** This shim's markdown route served the structured JSON " +
			"export and no markdown narration is available, so this file is narration only. " +
			"The authoritative findings are in `" +
			REPORT_JSON_REL_PATH +
			"`.\n\n" +
			`- Analysis timestamp: ${when}\n`,
	);
}

/**
 * Fail closed when the on-disk parent directory resolves (through symlinks)
 * outside `cwd`. The lexical `resolveWithinRoot` check runs first, but a
 * symlinked `ignore` directory defeats it — this resolves the real path after
 * the directory exists on disk.
 */
function assertRealDirWithinRoot(cwd: string, dir: string): void {
	if (!isPathWithinBase(realpathSync(dir), realpathSync(cwd))) {
		throw new Error(
			`Refusing to write report: "${dir}" resolves outside the project root (symlink escape).`,
		);
	}
}

/**
 * Write bytes via a uniquely-named temp file + rename. The temp name is
 * randomized so it can never be pre-planted, and it is created exclusively with
 * no-follow semantics (see `EXCLUSIVE_WRITE_FLAGS`); the parent directory is
 * verified against the real workspace path after creation. The temp is removed
 * on failure so a crashed write never leaves `*.tmp` next to the report.
 */
export function writeAtomically(
	writeFileFn: WriteFileFn,
	cwd: string,
	target: string,
	data: Uint8Array,
): void {
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	assertRealDirWithinRoot(cwd, dir);
	const tmp = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileFn(tmp, data);
		renameSync(tmp, target);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// best-effort cleanup; the original error is what matters
		}
		throw err;
	}
}

/**
 * Delete an artifact a previous fetch left behind, refusing to reach outside
 * `cwd` through a symlinked parent. Returns true when a file was removed.
 *
 * A refresh that finds no JSON must not leave the earlier analysis's JSON
 * artifact on disk: `dry-run.mts` auto-loads that default path, so a stale file
 * makes a partial run look complete.
 */
export function removeStaleArtifact(cwd: string, target: string): boolean {
	const dir = dirname(target);
	if (!existsSync(dir) || !existsSync(target)) return false;
	assertRealDirWithinRoot(cwd, dir);
	rmSync(target, { force: true });
	return true;
}
