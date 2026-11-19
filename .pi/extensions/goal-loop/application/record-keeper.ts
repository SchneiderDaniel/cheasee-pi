// ─── Record keeper: the loop's in-memory view of the record ──────
// Every write goes through `persist`, which stamps the checkpoint, applies the
// pending next-action and fails closed: a write error is returned with the last
// checkpoint that DID reach disk, never swallowed (R2.AC4).

import { failure, type NotifyFn, type Result } from "../../shared/result.ts";
import type { GoalRecord } from "../domain/goal-record.ts";
import type { GoalStore } from "./ports.ts";

const SOURCE = "goal-loop";

/**
 * Owns the current record, the checkpoint stamp and the fail-closed write
 * path. Shared by the lifecycle, boundary and publication collaborators so
 * only one place decides what "saved" means.
 */
export class RecordKeeper {
	private record: GoalRecord | null = null;
	private lastSavedCheckpoint: string | null = null;
	/** The next-action the agent reported for the following iteration. */
	private pendingNextAction = "";

	private readonly store: GoalStore;
	private readonly now: () => Date;
	private readonly notify?: NotifyFn;

	constructor(store: GoalStore, now: () => Date, notify?: NotifyFn) {
		this.store = store;
		this.now = now;
		this.notify = notify;
	}

	/** The in-memory record, or null when no goal was started in this session. */
	current(): GoalRecord | null {
		return this.record;
	}

	/** True when a goal exists and has not reached a terminal status. */
	hasActiveGoal(): boolean {
		const status = this.record?.status;
		return status !== undefined && status !== "complete" && status !== "cancelled";
	}

	/** Set the next-action carried into the following write. */
	setNextAction(action: string): void {
		this.pendingNextAction = action;
	}

	/**
	 * Write the record with a fresh checkpoint stamp.
	 *
	 * A write failure is returned, never swallowed: the caller pauses the loop
	 * and reports the last checkpoint that reached disk (R2.AC4).
	 */
	async persist(record: GoalRecord): Promise<Result<GoalRecord>> {
		const stamped: GoalRecord = {
			...record,
			lastCheckpoint: this.now().toISOString(),
			nextAction: this.pendingNextAction || record.nextAction,
		};
		const written = await this.store.write(stamped);
		if (!written.ok) {
			return failure(
				`goal state write failed: ${written.error} — last saved checkpoint: ${
					this.lastSavedCheckpoint ?? "(none)"
				}`,
				SOURCE,
			);
		}
		this.record = stamped;
		this.lastSavedCheckpoint = stamped.lastCheckpoint;
		return { ok: true, value: stamped };
	}

	/** Persist, and on failure pause in memory while surfacing the error. */
	async persistOrPause(record: GoalRecord): Promise<Result<GoalRecord>> {
		const persisted = await this.persist(record);
		if (persisted.ok) return persisted;
		// Fail closed: keep the in-memory record paused so no further iteration
		// can start from state that never reached disk.
		if (this.record) {
			this.record = { ...this.record, status: "paused", blocker: persisted.error };
		}
		this.notify?.error(persisted.error);
		return persisted;
	}
}
