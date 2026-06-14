// ─── Merge Conflict Resolution ──────────────────────────────────────
// Auto-merge logic for worktree branches.

import type { MergeResult } from "./types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDebugLogger } from "../lib/debug.ts";

export async function tryAutoMerge(
	worktreePath: string,
	branch: string,
	defaultBranch: string,
	remote: string,
	pi: ExtensionAPI,
): Promise<MergeResult> {
	const log = getDebugLogger();
	log.info("merge", `Auto-merge: ${branch} ← ${remote}/${defaultBranch}`, { worktreePath });

	try {
		log.info("merge", "Fetching base branch");
		const fetchResult = await pi.exec("git", ["fetch", remote, defaultBranch], {
			cwd: worktreePath,
			timeout: 60_000,
		});
		if (fetchResult.code !== 0) {
			const msg = (fetchResult.stderr || fetchResult.stdout || "").slice(0, 300);
			log.warn("merge", `git fetch failed: ${msg}`);
			return { success: false, conflictFiles: [], message: `git fetch failed: ${msg}` };
		}
		log.debug("merge", "Fetch OK");

		log.info("merge", `Merging ${remote}/${defaultBranch}`);
		const mergeResult = await pi.exec("git", ["merge", `${remote}/${defaultBranch}`, "--no-edit"], {
			cwd: worktreePath,
			timeout: 60_000,
		});
		if (mergeResult.code === 0) {
			log.info("merge", "Merge succeeded — no conflicts");
			return { success: true, conflictFiles: [], message: "Merge succeeded with no conflicts." };
		}

		// Merge failed — check for conflicts
		log.warn("merge", "Merge failed — checking for conflicts");
		const diffResult = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		const conflictFiles: string[] = diffResult.stdout
			? diffResult.stdout.trim().split("\n").filter(Boolean)
			: [];

		if (conflictFiles.length > 0) {
			log.warn("merge", `Conflicts in ${conflictFiles.length} files`, { conflictFiles });
			await pi
				.exec("git", ["merge", "--abort"], {
					cwd: worktreePath,
					timeout: 10_000,
				})
				.catch(() => {});
			log.info("merge", "Merge aborted");
			return {
				success: false,
				conflictFiles,
				message: `Merge conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}`,
			};
		}

		const msg = (mergeResult.stderr || mergeResult.stdout || "").slice(0, 300);
		log.warn("merge", `Merge failed with no conflicts: ${msg}`);
		return { success: false, conflictFiles: [], message: `Merge failed: ${msg}` };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error("merge", `Auto-merge threw: ${msg}`);
		return { success: false, conflictFiles: [], message: `Merge failed: ${msg}` };
	}
}
