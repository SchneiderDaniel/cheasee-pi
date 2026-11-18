// ─── Markdown goal store ─────────────────────────────────────────
// Adapter: maps a `GoalRecord` onto one Markdown file with YAML front matter
// and back. Owns the file policy — atomic writes, fail-closed parsing, path
// containment — and nothing else; cross-process locking lives in
// `goal-store-lock.ts`.
//
// Location: `<original checkout>/ignore/goals/<id>.md`. The root is an explicit
// constructor argument (never `process.cwd()`), so a goal running inside its own
// worktree still writes to the checkout the user invoked `/goal` from.
// `ignore/` is already gitignored, so the record can never be committed.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { failure, type Result } from "../../shared/result.ts";
import { isPathWithinBase } from "../../lib/path-containment.ts";
import { assertSafeGoalId } from "../domain/goal-record-id.ts";
import { extractAgentSection, serializeGoalRecord } from "../domain/goal-record-markdown.ts";
import { parseGoalRecord } from "../domain/goal-record-parse.ts";
import type { GoalRecord } from "../domain/goal-record.ts";
import type { GoalStore } from "../application/ports.ts";
import { GoalLock } from "./goal-store-lock.ts";

const SOURCE = "goal-store";

/** Directory name under the checkout root holding every goal record. */
export const GOAL_RECORD_DIR = "ignore/goals";
/** Lock file guarding cross-process double starts. */
export const GOAL_LOCK_FILE = ".lock";

/**
 * File-backed {@link GoalStore}.
 *
 * One instance per Pi session; `checkoutRoot` is the original checkout.
 */
export class MarkdownGoalStore implements GoalStore {
	private readonly root: string;
	private readonly lock: GoalLock;

	constructor(checkoutRoot: string) {
		this.root = checkoutRoot;
		this.lock = new GoalLock(join(this.directory, GOAL_LOCK_FILE), () => this.ensureDirectory());
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
			this.ensureDirectory();
		} catch (err: unknown) {
			return failure(describeError(`cannot write goal record ${record.id}`, err), SOURCE);
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
			return failure(describeError(`cannot write goal record ${path}`, err), SOURCE);
		}
	}

	/** Read one record. Fail-closed: every parse error names the file. */
	async read(id: string): Promise<Result<GoalRecord>> {
		let path: string;
		try {
			path = this.pathFor(id);
		} catch (err: unknown) {
			return failure(describeError(`cannot resolve goal record ${id}`, err), SOURCE);
		}
		let text: string;
		try {
			text = readFileSync(path, "utf-8");
		} catch (err: unknown) {
			return failure(describeError(`cannot read goal record ${path}`, err), SOURCE);
		}
		return this.parseFile(path, text);
	}

	/** Wrap the domain parser so the error names the file. */
	private parseFile(path: string, text: string): Result<GoalRecord> {
		const parsed = parseGoalRecord(text);
		if (parsed.ok) return parsed;
		return failure(`${path}: ${parsed.error}`, SOURCE);
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
			return failure(describeError(`cannot list ${this.directory}`, err), SOURCE);
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

	/** Cross-process exclusive lock (see `GoalLock`). */
	async acquire(): Promise<Result<void>> {
		return await this.lock.acquire();
	}

	/** Release our own lock. */
	async release(): Promise<void> {
		await this.lock.release();
	}
}

/** `prefix: message` for any thrown value. */
function describeError(prefix: string, err: unknown): string {
	return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}
