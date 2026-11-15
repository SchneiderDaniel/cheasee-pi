// Adapter: the single-writer lock a checkpoint holds for the whole run.
//
// A second run must fail closed instead of appending into a file another process
// owns. Releasing is best effort: the caller's own error is the one that matters,
// and a lock file that is already gone is not worth a second failure.

import lockfile from "proper-lockfile";

import { CheckpointLockError } from "./checkpoint-errors.ts";

export type Unlock = () => Promise<void>;

/** Take the checkpoint lock, or refuse with an operator-facing message. */
export async function acquireCheckpointLock(path: string): Promise<Unlock> {
	try {
		return await lockfile.lock(path, { realpath: false, retries: 0, stale: 120_000 });
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		throw new CheckpointLockError(`checkpoint is locked by another run: ${path} (${why})`);
	}
}

/** Release the lock if it is still held. */
export async function releaseCheckpointLock(unlock: Unlock | null): Promise<void> {
	if (unlock === null) return;
	try {
		await unlock();
	} catch {
		// The lock file may already be gone; nothing actionable remains.
	}
}
