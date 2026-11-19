// ─── Worktree cleanup (R3.AC5) ──────────────────────────────────
// The worktree and branch outlive every goal state, including a merged or
// closed pull request: removal happens only after the user explicitly confirms
// it, so an autonomous loop can never delete work the user has not reviewed.

import { failure, type NotifyFn, type Result } from "../../shared/result.ts";
import type { RecordKeeper } from "./record-keeper.ts";
import type { GoalWorkspace } from "./ports.ts";

const SOURCE = "goal-loop";

/** Remove the goal worktree once the user confirms (never automatically). */
export async function performGoalCleanup(input: {
	keeper: RecordKeeper;
	workspace: GoalWorkspace;
	notify?: NotifyFn;
	confirmed: boolean;
}): Promise<Result<void>> {
	const record = input.keeper.current();
	if (!record) return failure("no goal to clean up", SOURCE);
	if (!record.worktree) return failure(`goal ${record.id} has no worktree to remove`, SOURCE);

	const removed = await input.workspace.discardGoalWorktree({
		path: record.worktree,
		confirmed: input.confirmed,
	});
	if (!removed.ok) return removed;
	input.notify?.info(`worktree ${record.worktree} removed`);
	return removed;
}
