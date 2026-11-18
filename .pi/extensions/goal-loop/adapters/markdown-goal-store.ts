// ─── Markdown goal store ─────────────────────────────────────────
// Adapter: maps a GoalRecord onto one Markdown file with YAML front matter and
// back. Owns I/O policy — atomic writes, fail-closed parsing, the cross-process
// lock and path containment — and nothing else.
//
// Location: `<original checkout>/ignore/goals/<id>.md`. The root is an explicit
// constructor argument (never `process.cwd()`), so a goal running inside its own
// worktree still writes to the checkout the user invoked `/goal` from.
// `ignore/` is already gitignored, so the record can never be committed.

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { failure, type Result } from "../../shared/result.ts";
import { isPathWithinBase } from "../../lib/path-containment.ts";
import {
	assertSafeGoalId,
	extractAgentSection,
	parseGoalRecord,
	serializeGoalRecord,
	type GoalRecord,
} from "../domain/goal-record.ts";
import type { GoalStore } from "../application/ports.ts";

const SOURCE = "goal-store";

/** Directory name under the checkout root holding every goal record. */
export const GOAL_RECORD_DIR = "ignore/goals";
/** Lock file guarding cross-process double starts. */
export const GOAL_LOCK_FILE = ".lock";

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

/**
 * File-backed {@link GoalStore}.
 *
 * One instance per Pi session; `checkoutRoot` is the original checkout.
 */
export class MarkdownGoalStore implements GoalStore {
	private readonly root: string;
	private lockHeld = false;

	constructor(checkoutRoot: string) {
		this.root = checkoutRoot;
	}

	/** `<checkout>/ignore/goals`. */
	get directory(): string {
		return join(this.root, GOAL_RECORD_DIR);
	}

	/**
	 * Absolute record path for `id`.
	 *
	 * Rejects traversal and absolute ids BEFORE any I/O: `assertSafeGoalId` bans
	 * separators and `..`, and the containment check re-verifies the assembled
	 * path is inside the record directory.
	 */
	pathFor(id: string): string {
		assertSafeGoalId(id);
		const path = join(this.directory, `${id}.md`);
		if (!isPathWithinBase(path, this.directory)) {
			throw new Error(`goal id "${id}" resolves outside ${this.directory}`);
		}
		return path;
	}

	/** Create the record directory (idempotent). */
	private ensureDirectory(): void {
		mkdirSync(this.directory, { recursive: true });
	}

	/**
	 * Write the record atomically (temp file + rename) so a crash mid-write
	 * cannot leave a truncated front matter.
	 *
	 * The agent-owned body section is carried over from the existing file: the
	 * loop regenerates its own sections and never authors the agent's.
	 */
	async write(record: GoalRecord): Promise<Result<void>> {
		let path: string;
		try {
			path = this.pathFor(record.id);
		} catch (err: unknown) {
			return failure(err instanceof Error ? err.message : String(err), SOURCE);
		}
		try {
			this.ensureDirectory();
		} catch (err: unknown) {
			return failure(
				`cannot create ${this.directory}: ${err instanceof Error ? err.message : String(err)}`,
				SOURCE,
			);
		}

		const existingAgentSection = existsSync(path)
			? extractAgentSection(readFileSync(path, "utf-8"))
			: "";
		const content = serializeGoalRecord(record, existingAgentSection);
		const tmp = `${path}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, content, "utf-8");
			renameSync(tmp, path);
			return { ok: true, value: undefined };
		} catch (err: unknown) {
			rmSync(tmp, { force: true });
			return failure(
				`cannot write goal record ${path}: ${err instanceof Error ? err.message : String(err)}`,
				SOURCE,
			);
		}
	}

	/** Read one record. Fail-closed: every parse error names the file. */
	async read(id: string): Promise<Result<GoalRecord>> {
		let path: string;
		try {
			path = this.pathFor(id);
		} catch (err: unknown) {
			return failure(err instanceof Error ? err.message : String(err), SOURCE);
		}
		let text: string;
		try {
			text = readFileSync(path, "utf-8");
		} catch (err: unknown) {
			return failure(
				`cannot read goal record ${path}: ${err instanceof Error ? err.message : String(err)}`,
				SOURCE,
			);
		}
		return this.parseFile(path, text);
	}

	/** Wrap the domain parser so the error names the file. */
	private parseFile(path: string, text: string): Result<GoalRecord> {
		const parsed = parseGoalRecord(text);
		if (!parsed.ok) return failure(`${path}: ${parsed.error}`, SOURCE);
		return parsed;
	}

	/**
	 * Every `*.md` record, in directory order. `.lock` and stray files are
	 * ignored; a record that fails to parse fails the whole listing (an
	 * unreadable record could be the active goal).
	 */
	async list(): Promise<Result<GoalRecord[]>> {
		if (!existsSync(this.directory)) return { ok: true, value: [] };
		let entries: string[];
		try {
			entries = readdirSync(this.directory);
		} catch (err: unknown) {
			return failure(
				`cannot list ${this.directory}: ${err instanceof Error ? err.message : String(err)}`,
				SOURCE,
			);
		}
		const records: GoalRecord[] = [];
		for (const entry of entries.sort()) {
			if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
			const path = join(this.directory, entry);
			const parsed = this.parseFile(path, readFileSync(path, "utf-8"));
			if (!parsed.ok) return parsed;
			records.push(parsed.value);
		}
		return { ok: true, value: records };
	}

	/** `<checkout>/ignore/goals/.lock`. */
	private get lockPath(): string {
		return join(this.directory, GOAL_LOCK_FILE);
	}

	/**
	 * Acquire the cross-process lock.
	 *
	 * A lock whose pid is still alive refuses the start; a stale pid (crashed
	 * process) is taken over. The lock is created with `wx` so two processes
	 * racing cannot both win.
	 */
	async acquire(): Promise<Result<void>> {
		try {
			this.ensureDirectory();
		} catch (err: unknown) {
			return failure(
				`cannot create ${this.directory}: ${err instanceof Error ? err.message : String(err)}`,
				SOURCE,
			);
		}

		const held = this.readLock();
		if (held && isPidAlive(held.pid) && held.pid !== process.pid) {
			return failure(
				`goal lock held by pid ${held.pid} since ${held.startedAt} — another goal loop is running`,
				SOURCE,
			);
		}
		if (held) {
			// Stale (or our own): take it over.
			rmSync(this.lockPath, { force: true });
		}

		const payload: LockPayload = { pid: process.pid, startedAt: new Date().toISOString() };
		try {
			const fd = openSync(this.lockPath, "wx");
			try {
				writeFileSync(fd, JSON.stringify(payload), "utf-8");
			} finally {
				closeSync(fd);
			}
			this.lockHeld = true;
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

	private readLock(): LockPayload | null {
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
		if (!this.lockHeld) return;
		const held = this.readLock();
		if (held && held.pid !== process.pid) {
			this.lockHeld = false;
			return;
		}
		rmSync(this.lockPath, { force: true });
		this.lockHeld = false;
	}
}
