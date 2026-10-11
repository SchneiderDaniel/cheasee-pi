// ─── Worktree Removal Guard ──────────────────────────────────────
// cleanupStalePipelineState drives `rm -rf` from a repo-local JSON state
// file, so `state.worktreePath` is untrusted input: any code that can write
// `.pi/supervisor-state-*.json` could name `/workspaces/main` and delete the
// main checkout. A worktree path may only be removed when it is (a) inside
// the worktree base after full symlink canonicalization and (b) a registered
// linked worktree. Fail closed: anything that cannot be verified is skipped.
//
// Split out of worktree.ts (issue #2001). Owns all path-safety policy; the
// lifecycle (create/cleanup/install/reconcile) stays in worktree.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { execChecked, type Result } from "./result.ts";

export interface WorktreeEntry {
	path: string;
	bare: boolean;
	prunable: boolean;
	locked: boolean;
	detached: boolean;
	/** `refs/heads/<name>`, or null when bare / detached. */
	branch: string | null;
}

/**
 * A worktree the guard proved removable, with the branch it is actually
 * registered on — see `verifyRemovableWorktree`.
 */
interface VerifiedWorktree {
	/** Canonical absolute path safe to delete. */
	path: string;
	/**
	 * `refs/heads/<name>` the matched worktree carries, or null when the entry
	 * is bare/detached. The caller must not delete a branch for a null — the
	 * branch name in the state file is untrusted and must match this identity.
	 */
	branch: string | null;
}

/**
 * Parse `git worktree list --porcelain -z` output.
 *
 * `-z` is required: each field is NUL-terminated and records are separated by
 * an extra NUL, so a worktree path containing a newline survives as one entry.
 * Splitting on newlines instead would split such a path in two.
 */
export function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;
	for (const token of stdout.split("\0")) {
		if (token.trim() === "") {
			continue; // record separator / trailing NUL
		}
		if (token.startsWith("worktree ")) {
			if (current) {
				entries.push(current);
			}
			current = {
				path: token.slice("worktree ".length),
				bare: false,
				prunable: false,
				locked: false,
				detached: false,
				branch: null,
			};
			continue;
		}
		if (!current) {
			continue; // attribute before any `worktree` line — ignore
		}
		if (token === "bare") {
			current.bare = true;
		} else if (token === "detached") {
			current.detached = true;
		} else if (token === "locked" || token.startsWith("locked ")) {
			current.locked = true;
		} else if (token === "prunable" || token.startsWith("prunable ")) {
			current.prunable = true;
		} else if (token.startsWith("branch ")) {
			current.branch = token.slice("branch ".length);
		}
	}
	if (current) {
		entries.push(current);
	}
	return entries;
}

/**
 * Canonicalize a path: resolve `./`, `../` and every symlink.
 *
 * A missing leaf is allowed (a stale worktree dir may already be gone): its
 * parent is canonicalized and the basename re-attached, so symlinked
 * intermediate components still resolve to their real target — a plain
 * string/abspath check would let a symlink under the base point outside it.
 *
 * @returns the canonical absolute path, or `null` when it cannot be resolved.
 */
export function canonicalizePath(p: string): string | null {
	const abs = resolvePath(p);
	try {
		return realpathSync(abs);
	} catch {
		// Leaf does not exist — fall through to parent resolution
	}
	const parent = dirname(abs);
	if (parent === abs) {
		return null;
	}
	try {
		return join(realpathSync(parent), basename(abs));
	} catch {
		return null;
	}
}

/**
 * Strict containment: true only for a proper descendant of `base`.
 *
 * `candidate === base` returns false — removing the whole worktree base would
 * delete every sibling worktree. The separator-suffixed compare rejects
 * `base-evil` siblings that a bare `startsWith(base)` would accept.
 */
export function isStrictlyInside(base: string, candidate: string): boolean {
	const b = resolvePath(base);
	const c = resolvePath(candidate);
	if (c === b) {
		return false;
	}
	const prefix = b.endsWith(sep) ? b : b + sep;
	return c.startsWith(prefix);
}

/**
 * Fetch the linked-worktree allowlist. Fails closed: a git error or an empty
 * listing yields ok=false, and callers must treat that as "remove nothing".
 */
export async function fetchWorktreeAllowlist(
	pi: ExtensionAPI,
	cwd: string,
): Promise<Result<WorktreeEntry[]>> {
	const res = await execChecked(pi, "git", ["worktree", "list", "--porcelain", "-z"], {
		cwd,
		timeout: 15000,
	});
	if (res.code !== 0) {
		return {
			ok: false,
			error: res.stderr || res.stdout || "git worktree list failed",
			source: "worktree",
		};
	}
	const entries = parseWorktreeListPorcelain(res.stdout);
	if (entries.length === 0) {
		return { ok: false, error: "git worktree list returned no worktrees", source: "worktree" };
	}
	return { ok: true, value: entries };
}

/**
 * Decide whether `candidate` may be removed. Returns the canonical path to
 * remove plus the branch the matched worktree actually carries, or an error
 * describing why removal was refused.
 *
 * Every refusal is deliberate and fail-closed; the caller must skip all
 * destructive steps (worktree remove, branch delete, rm) and leave the state
 * file in place for manual cleanup. The returned branch is the *verified*
 * identity — the branch named by the untrusted state file is only safe to
 * delete when it matches it.
 */
export function verifyRemovableWorktree(
	entries: WorktreeEntry[],
	cwd: string,
	baseDir: string,
	candidate: string,
	defaultBranch?: string | null,
): Result<VerifiedWorktree> {
	const reject = (why: string): Result<VerifiedWorktree> => ({
		ok: false,
		error: why,
		source: "worktree",
	});

	const canonicalBase = canonicalizePath(baseDir);
	if (!canonicalBase) {
		return reject(`worktree base ${baseDir} cannot be resolved`);
	}

	// Resolve relative candidates against `cwd` (the repo root this run was
	// invoked with) — never process.cwd(), which is unrelated to the repo.
	const canonicalCandidate = canonicalizePath(resolvePath(cwd, candidate));
	if (!canonicalCandidate) {
		return reject(`worktreePath ${candidate} cannot be resolved`);
	}
	if (!isStrictlyInside(canonicalBase, canonicalCandidate)) {
		return reject(`worktreePath ${candidate} is outside worktree base ${canonicalBase}`);
	}

	// Never the checkout the supervisor itself runs from.
	const canonicalCwd = canonicalizePath(cwd);
	if (canonicalCwd && canonicalCwd === canonicalCandidate) {
		return reject(`worktreePath ${candidate} is the main repository root`);
	}

	if (entries.length === 0) {
		return reject("no registered worktrees to verify against");
	}

	// `git worktree list` prints the raw admin `gitdir` file content. When that
	// file holds a relative path (`../../../main/.git`, as the docker worktree
	// bootstrap writes it) git resolves it against the worktree's own admin dir,
	// not against cwd — so resolve relative entries the same way. Absolute
	// entries (normal git) ignore the base entirely.
	// `worktree list` prints the main worktree first; for a bare repo that entry
	// is the bare dir, which is where the `worktrees/` admin dir lives.
	const adminRoot = entries[0].bare ? join(entries[0].path, "worktrees") : null;

	let matched: WorktreeEntry | null = null;
	for (const entry of entries) {
		const resolved = isAbsolute(entry.path)
			? canonicalizePath(entry.path)
			: canonicalizePath(
					resolvePath(adminRoot ? join(adminRoot, basename(entry.path)) : cwd, entry.path),
				);
		if (resolved !== null && resolved === canonicalCandidate) {
			matched = entry;
			break;
		}
	}
	if (!matched) {
		return reject(`worktreePath ${candidate} is not a registered worktree`);
	}
	if (matched.bare) {
		return reject(`worktreePath ${candidate} is a bare repository`);
	}
	if (matched === entries[0]) {
		return reject(`worktreePath ${candidate} is the main worktree`);
	}
	// The checkout carrying the default branch is the repository the pipeline
	// runs against. `git worktree remove` will not remove the main worktree,
	// but in a bare+linked layout (`--bare` + sibling checkouts) the main
	// checkout is an ordinary linked entry and is listed as such — the branch
	// it carries is the only layout-independent way to recognise it.
	if (defaultBranch && matched.branch === `refs/heads/${defaultBranch}`) {
		return reject(`worktreePath ${candidate} carries the default branch ${defaultBranch}`);
	}

	return { ok: true, value: { path: canonicalCandidate, branch: matched.branch } };
}
