// ─── Worktree Removal Guard (Supervisor re-export) ───────────────
// The guard moved to `.pi/extensions/shared/git/worktree-guard.ts` (issue
// #2138) so the goal-loop extension runs the same removal policy. This module
// keeps the historical import path (`./worktree-guard.ts`) and adapts Pi's
// `exec` port to the shared `ExecLike` signature.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	fetchWorktreeAllowlist as sharedFetchWorktreeAllowlist,
	type WorktreeEntry,
} from "../../shared/git/worktree-guard.ts";
import type { Result } from "../../shared/result.ts";

export {
	canonicalizePath,
	isStrictlyInside,
	parseWorktreeListPorcelain,
	verifyRemovableWorktree,
} from "../../shared/git/worktree-guard.ts";
export type { VerifiedWorktree, WorktreeEntry } from "../../shared/git/worktree-guard.ts";

/** Allowlist fetch bound to the Pi extension API. */
export async function fetchWorktreeAllowlist(
	pi: ExtensionAPI,
	cwd: string,
): Promise<Result<WorktreeEntry[]>> {
	return await sharedFetchWorktreeAllowlist(pi.exec.bind(pi), cwd);
}
