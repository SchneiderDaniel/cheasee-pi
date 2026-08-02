// ─── Rebase Before Push ─────────────────────────────────────────────
// Pre-push rebase onto latest base branch to avoid merge conflicts
// at PR creation time. Complements post-PR merge conflict handling
// in pipeline/merge.ts (which catches any race-window conflicts).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RebaseResult } from "../config/types.ts";
import { getDebugLogger } from "../lib/debug.ts";

/** Maximum retry attempts for git fetch (transient network flakes) */
const MAX_FETCH_RETRIES = 3;

/** Delay (ms) before each retry attempt. Index 0 = delay before retry 1. */
const FETCH_RETRY_DELAYS_MS = [3000, 5000, 10000];

/**
 * Rebase stderr marker for the untracked-file checkout collision:
 * "error: The following untracked working tree files would be overwritten by checkout:".
 * A checkout-block, not a merge conflict — `git diff --diff-filter=U` stays empty.
 */
const UNTRACKED_COLLISION_PATTERN =
	"untracked working tree files would be overwritten by checkout";

/** Max chars of rebase stderr included in a user-facing message. */
const MAX_STDERR_IN_MESSAGE = 500;

/** Trim and bound rebase stderr for user-facing failure messages. */
function stderrExcerpt(stderr: string): string {
	const trimmed = stderr.trim();
	return trimmed.length > MAX_STDERR_IN_MESSAGE
		? `${trimmed.slice(0, MAX_STDERR_IN_MESSAGE)}…`
		: trimmed;
}

/** Split newline-separated command output, dropping empty/whitespace lines. */
function splitLines(output: string): string[] {
	return output ? output.trim().split("\n").filter((s) => s.trim().length > 0) : [];
}

/**
 * Untracked (non-ignored) files in the worktree that collide with paths
 * tracked at the base ref — these block `git checkout` during rebase.
 */
async function findUntrackedCollisions(
	worktreePath: string,
	baseRef: string,
	pi: ExtensionAPI,
): Promise<string[]> {
	const untrackedResult = await pi.exec(
		"git",
		["ls-files", "--others", "--exclude-standard"],
		{ cwd: worktreePath, timeout: 10_000 },
	);
	const baseTreeResult = await pi.exec(
		"git",
		["ls-tree", "-r", "--name-only", baseRef],
		{ cwd: worktreePath, timeout: 10_000 },
	);
	if (untrackedResult.code !== 0 || baseTreeResult.code !== 0) {
		throw new Error(
			untrackedResult.stderr || baseTreeResult.stderr || "untracked-collision detection failed",
		);
	}
	const untracked = splitLines(untrackedResult.stdout);
	const basePaths = new Set(splitLines(baseTreeResult.stdout));
	return untracked.filter((p) => basePaths.has(p));
}

/** Scoped clean of exactly the given untracked paths (never bare `git clean -fd`). */
async function removeUntrackedPaths(
	worktreePath: string,
	paths: string[],
	pi: ExtensionAPI,
): Promise<void> {
	const cleanResult = await pi.exec("git", ["clean", "-fd", "--", ...paths], {
		cwd: worktreePath,
		timeout: 10_000,
	});
	if (cleanResult.code !== 0) {
		throw new Error(cleanResult.stderr || cleanResult.stdout || "git clean failed");
	}
}

/**
 * Attempt to rebase the worktree branch onto the latest remote base branch.
 * Fetches the remote base branch first, then rebases with --autostash.
 * On conflict, detects conflicted files, aborts the rebase, and returns
 * the list of conflicting files.
 *
 * Mirror pattern: same shape as tryAutoMerge in config/merge.ts but
 * uses rebase instead of merge, uses --autostash, and has fetch retry.
 */
export async function tryRebaseOntoBase(
	worktreePath: string,
	defaultBranch: string,
	remote: string,
	pi: ExtensionAPI,
): Promise<RebaseResult> {
	const log = getDebugLogger();
	log.info("rebase", `Rebasing worktree ${worktreePath} ← ${remote}/${defaultBranch}`);

	// ─── Phase 1: Fetch remote base branch with retry ─────────────
	let fetchSucceeded = false;
	let lastFetchErr: unknown;
	for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
		try {
			if (attempt > 0) {
				const delayMs = FETCH_RETRY_DELAYS_MS[attempt - 1] ?? 5000;
				log.info("rebase", `Fetch retry ${attempt + 1}/${MAX_FETCH_RETRIES} after ${delayMs}ms`);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
			const fetchResult = await pi.exec("git", ["fetch", remote, defaultBranch], {
				cwd: worktreePath,
				timeout: 60_000,
			});
			if (fetchResult.code !== 0) {
				throw new Error(fetchResult.stderr || fetchResult.stdout || "git fetch failed");
			}
			fetchSucceeded = true;
			log.info("rebase", "Fetch OK");
			break;
		} catch (fetchErr: unknown) {
			lastFetchErr = fetchErr;
			const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
			log.warn("rebase", `Fetch attempt ${attempt + 1}/${MAX_FETCH_RETRIES} failed: ${msg}`);
		}
	}

	if (!fetchSucceeded) {
		const msg = lastFetchErr instanceof Error ? lastFetchErr.message : String(lastFetchErr);
		log.error("rebase", `All ${MAX_FETCH_RETRIES} fetch attempts failed: ${msg}`);
		return {
			success: false,
			conflictFiles: [],
			message: `Fetch failed after ${MAX_FETCH_RETRIES} attempts: ${msg}`,
		};
	}

	// ─── Phase 2: Rebase onto fetched base branch ─────────────────
	// Captured on every failure path (resolve-fail and reject) so the
	// real git cause survives into the user-facing message.
	let rebaseFailureStderr = "";
	const runRebase = async (): Promise<boolean> => {
		try {
			const rebaseResult = await pi.exec(
				"git",
				["rebase", "--autostash", `${remote}/${defaultBranch}`],
				{
					cwd: worktreePath,
					timeout: 60_000,
				},
			);
			if (rebaseResult.code === 0) {
				log.info("rebase", "Rebase succeeded — no conflicts");
				return true;
			}
			rebaseFailureStderr = (rebaseResult.stderr || rebaseResult.stdout || "").trim();
			log.warn("rebase", `Rebase failed: ${rebaseFailureStderr.slice(0, 300)}`);
			return false;
		} catch (rebaseErr: unknown) {
			const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
			rebaseFailureStderr = msg;
			log.warn("rebase", `Rebase threw: ${msg}`);
			return false;
		}
	};

	if (await runRebase()) {
		return { success: true, conflictFiles: [], message: "Rebase succeeded with no conflicts." };
	}

	// ─── Phase 2.5: Untracked-file collision recovery ─────────────
	// --autostash does not stash untracked files, so an artifact at a
	// path the base branch newly tracks blocks checkout ("untracked
	// working tree files would be overwritten by checkout") without
	// producing merge conflicts. Remove ONLY the colliding paths and
	// retry the rebase once.
	if (rebaseFailureStderr.includes(UNTRACKED_COLLISION_PATTERN)) {
		log.warn("rebase", "Untracked-file checkout collision detected — attempting scoped cleanup");
		let collisions: string[];
		try {
			collisions = await findUntrackedCollisions(
				worktreePath,
				`${remote}/${defaultBranch}`,
				pi,
			);
		} catch (detectErr: unknown) {
			const msg = detectErr instanceof Error ? detectErr.message : String(detectErr);
			log.error("rebase", `Untracked-collision detection failed: ${msg}`);
			return {
				success: false,
				conflictFiles: [],
				message: `Rebase failed: ${stderrExcerpt(rebaseFailureStderr)}`,
			};
		}

		if (collisions.length > 0) {
			let cleaned = true;
			try {
				await removeUntrackedPaths(worktreePath, collisions, pi);
			} catch (cleanErr: unknown) {
				cleaned = false;
				const msg = cleanErr instanceof Error ? cleanErr.message : String(cleanErr);
				log.error("rebase", `Scoped clean of untracked collisions failed: ${msg}`);
			}
			if (cleaned && (await runRebase())) {
				log.info(
					"rebase",
					`Rebase succeeded after removing ${collisions.length} untracked artifact(s) blocking checkout`,
				);
				return {
					success: true,
					conflictFiles: [],
					message: `Rebase succeeded after removing ${collisions.length} untracked artifact(s) blocking checkout: ${collisions.join(", ")}`,
				};
			}
			log.warn(
				"rebase",
				"Rebase retry failed after cleanup — falling through to conflict detection",
			);
		}
	}

	// Detect conflicts via unmerged paths
	try {
		const diffResult = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		const conflictFiles = splitLines(diffResult.stdout);

		if (conflictFiles.length > 0) {
			log.warn("rebase", `Conflicts in ${conflictFiles.length} files`, { conflictFiles });
			await pi
				.exec("git", ["rebase", "--abort"], {
					cwd: worktreePath,
					timeout: 10_000,
				})
				.catch(() => {});
			log.info("rebase", "Rebase aborted after conflicts");

			// ─── Fallback: try merge ──────────────────────────────────
			// Rebase fails when origin/main touched same file in overlapping
			// lines (per-commit patch application). Merge's 3-way combine is
			// more tolerant of same-file changes in non-overlapping regions.
			// If merge also fails, fall through to original conflict result.
			log.info("rebase", "Trying merge fallback after rebase conflict");
			try {
				const mergeResult = await pi.exec(
					"git",
					["merge", "--no-edit", `${remote}/${defaultBranch}`],
					{ cwd: worktreePath, timeout: 60_000 },
				);
				if (mergeResult.code === 0) {
					log.info("rebase", "Merge fallback succeeded after rebase conflict");
					return {
						success: true,
						conflictFiles: [],
						message: "Rebase conflicted, merge fallback succeeded.",
					};
				}
			} catch (mergeErr: unknown) {
				const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
				log.warn("rebase", `Merge fallback also failed: ${msg}`);
			}

			// Merge also failed — abort merge, return original conflict result
			await pi
				.exec("git", ["merge", "--abort"], {
					cwd: worktreePath,
					timeout: 10_000,
				})
				.catch(() => {});
			log.info("rebase", "Merge fallback also failed — aborted");
			return {
				success: false,
				conflictFiles,
				message: `Rebase conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}`,
			};
		}

		// No conflict files detected but rebase still failed — abort to restore state
		await pi
			.exec("git", ["rebase", "--abort"], {
				cwd: worktreePath,
				timeout: 10_000,
			})
			.catch(() => {});
		const msg = rebaseFailureStderr
			? `Rebase failed: ${stderrExcerpt(rebaseFailureStderr)}`
			: "Rebase failed (no conflict files detected)";
		log.warn("rebase", msg);
		return { success: false, conflictFiles: [], message: msg };
	} catch (diffErr: unknown) {
		// diff --diff-filter=U failed — still try to abort
		const msg = diffErr instanceof Error ? diffErr.message : String(diffErr);
		log.error("rebase", `Conflict detection failed: ${msg}`);

		// Try to abort even if diff failed
		await pi
			.exec("git", ["rebase", "--abort"], {
				cwd: worktreePath,
				timeout: 10_000,
			})
			.catch(() => {});
		return {
			success: false,
			conflictFiles: [],
			message: `Rebase failed: ${stderrExcerpt(rebaseFailureStderr || msg)}`,
		};
	}
}
