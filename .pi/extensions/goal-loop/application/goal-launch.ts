// ─── Worktree + first generation (R1.AC3, R3.AC2) ───────────────
// Once clarification is ready, work begins without a confirmation prompt: the
// record is written, the HEAD-based worktree is created, then the first
// generation starts. A failure at any step pauses the goal and keeps the
// worktree/branch intact for the user to inspect (R3.AC5).

import type { NotifyFn, Result } from "../../shared/result.ts";
import { transitionTo, type GoalRecord } from "../domain/goal-record.ts";
import { buildGenerationPrompt, goalBranchName } from "./goal-prompts.ts";
import type { RecordKeeper } from "./record-keeper.ts";
import type { GoalAgentRuntime, GoalWorkspace, WorkspaceOutcome } from "./ports.ts";

/** What a launch produced: the record plus whether work actually started. */
export interface LaunchOutcome {
	record: GoalRecord;
	started: boolean;
}

/** Ports a launch needs. */
export interface LaunchDeps {
	workspace: GoalWorkspace;
	runtime: GoalAgentRuntime;
	notify?: NotifyFn;
}

/** Record a blocker, pause, and keep the worktree/branch intact. */
export async function pauseWithBlocker(
	keeper: RecordKeeper,
	notify: NotifyFn | undefined,
	record: GoalRecord,
	blocker: string,
): Promise<Result<GoalRecord>> {
	const paused = transitionTo(record, "paused");
	const persisted = await keeper.persist({ ...paused, blocker });
	if (!persisted.ok) return persisted;
	notify?.error(`goal paused: ${blocker}`);
	return persisted;
}

/**
 * Prepare the goal worktree and start the first generation from the record.
 *
 * The worktree step refuses a dirty or detached checkout (`clean: false`) and
 * leaves the user's tree untouched (R3.AC2). A start failure pauses the goal
 * with the git/session error as the blocker (R3.AC5).
 */
export async function launchWork(input: {
	keeper: RecordKeeper;
	deps: LaunchDeps;
	record: GoalRecord;
}): Promise<Result<LaunchOutcome>> {
	const { keeper, deps } = input;
	const record = input.record;
	const prepared = await deps.workspace.prepare({
		goalId: record.id,
		branch: goalBranchName(record),
	});
	if (!prepared.ok) return await pausedOutcome(keeper, deps.notify, record, prepared.error);
	const outcome: WorkspaceOutcome = prepared.value;
	if (!outcome.clean) {
		return await pausedOutcome(keeper, deps.notify, record, outcome.reason);
	}

	const withWorkspace: GoalRecord = {
		...record,
		worktree: outcome.path,
		branch: outcome.branch,
		inFlight: true,
	};
	const workspacePersisted = await keeper.persistOrPause(withWorkspace);
	if (!workspacePersisted.ok) return workspacePersisted;

	const started = await deps.runtime.start({
		goalId: withWorkspace.id,
		worktree: outcome.path,
		model: withWorkspace.config.model,
		prompt: buildGenerationPrompt(withWorkspace),
		generation: withWorkspace.generation,
	});
	if (!started.ok) {
		return await pausedOutcome(keeper, deps.notify, withWorkspace, started.error);
	}
	deps.notify?.info(
		`goal ${withWorkspace.id} started — worktree ${outcome.path}, branch ${outcome.branch}`,
	);
	return { ok: true, value: { record: withWorkspace, started: true } };
}

/** Pause on a blocker and report it as a non-started launch. */
async function pausedOutcome(
	keeper: RecordKeeper,
	notify: NotifyFn | undefined,
	record: GoalRecord,
	blocker: string,
): Promise<Result<LaunchOutcome>> {
	const paused = await pauseWithBlocker(keeper, notify, record, blocker);
	if (!paused.ok) return paused;
	return { ok: true, value: { record: paused.value, started: false } };
}

/**
 * Pause a running goal for user direction from any non-terminal status.
 *
 * `verifying` cannot transition straight to `paused`, so the record returns to
 * `active` first (the transition table is the only authority here).
 */
export async function pauseForUser(
	keeper: RecordKeeper,
	notify: NotifyFn | undefined,
	record: GoalRecord,
	blocker: string,
): Promise<Result<GoalRecord>> {
	const base = record.status === "verifying" ? transitionTo(record, "active") : record;
	return await pauseWithBlocker(keeper, notify, base, blocker);
}
