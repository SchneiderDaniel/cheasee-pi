// ─── Cross-process goal lock ────────────────────────────────────
// `ignore/goals/.lock` carries the owning pid so a second Pi process cannot
// start a goal in the same checkout. A live holder refuses the start; a stale
// pid (crashed process) is taken over, so one crash cannot wedge every future
// goal forever.

import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { failure, type Result } from "../../shared/result.ts";

const SOURCE = "goal-store";

interface LockPayload {
	pid: number;
	startedAt: string;
}

/** True when a process with `pid` exists. EPERM means it exists but is foreign. */
function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** One goal-lock file, owned by this process once acquired. */
export class GoalLock {
	private held = false;

	private readonly lockPath: string;
	/** Directory creation is the caller's job; this keeps the error local. */
	private readonly ensureDirectory: () => void;

	constructor(lockPath: string, ensureDirectory: () => void) {
		this.lockPath = lockPath;
		this.ensureDirectory = ensureDirectory;
	}

	/**
	 * Acquire the lock.
	 *
	 * The file is created with `wx`, so two processes racing cannot both win.
	 */
	async acquire(): Promise<Result<void>> {
		try {
			this.ensureDirectory();
		} catch (err: unknown) {
			return failure(
				`cannot create the goal record directory: ${err instanceof Error ? err.message : String(err)}`,
				SOURCE,
			);
		}

		const current = this.read();
		if (current && isPidAlive(current.pid) && current.pid !== process.pid) {
			return failure(
				`goal lock held by pid ${current.pid} since ${current.startedAt} — another goal loop is running`,
				SOURCE,
			);
		}
		if (current) rmSync(this.lockPath, { force: true });

		const payload: LockPayload = { pid: process.pid, startedAt: new Date().toISOString() };
		try {
			const fd = openSync(this.lockPath, "wx");
			try {
				writeFileSync(fd, JSON.stringify(payload), "utf-8");
			} finally {
				closeSync(fd);
			}
			this.held = true;
			return { ok: true, value: undefined };
		} catch (err: unknown) {
			return failure(
				`cannot acquire goal lock ${this.lockPath}: ${
					err instanceof Error ? err.message : String(err)
				}`,
				SOURCE,
			);
		}
	}

	private read(): LockPayload | null {
		if (!existsSync(this.lockPath)) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.lockPath, "utf-8"));
			if (typeof parsed !== "object" || parsed === null) return null;
			const payload = parsed as Record<string, unknown>;
			if (typeof payload.pid !== "number") return null;
			return {
				pid: payload.pid,
				startedAt: typeof payload.startedAt === "string" ? payload.startedAt : "unknown",
			};
		} catch {
			// Unreadable lock: treat as stale so a crashed write cannot wedge
			// every future goal forever.
			return { pid: -1, startedAt: "unknown" };
		}
	}

	/** Release our own lock. Never removes a lock another process owns. */
	async release(): Promise<void> {
		if (!this.held) return;
		const current = this.read();
		if (current && current.pid !== process.pid) {
			this.held = false;
			return;
		}
		rmSync(this.lockPath, { force: true });
		this.held = false;
	}
}
