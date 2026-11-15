// Adapter: append-only JSONL checkpoint on disk.
//
// One file per audit. `open` takes a lock and holds it until `close`, so exactly
// one process writes; every append is a single `appendFileSync`, so a crash can
// only tear the tail. Record shapes live in `checkpoint-records.ts`, the reader
// in `checkpoint-reader.ts`, replay in `checkpoint-replay.ts`, archiving in
// `checkpoint-archive.ts`, and the failures in `checkpoint-errors.ts`.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

import { archivePrevious } from "./checkpoint-archive.ts";
import {
	CheckpointError,
	CheckpointLockError,
	CheckpointMismatchError,
} from "./checkpoint-errors.ts";
import { readCheckpointRecords } from "./checkpoint-reader.ts";
import {
	CHECKPOINT_SCHEMA_VERSION,
	type CheckpointHeaderRecord,
	type CheckpointRecord,
} from "./checkpoint-records.ts";
import { emptyPrior, inventoryDrift, summarize } from "./checkpoint-replay.ts";
import {
	issueIntentRecord,
	issueRecord,
	pendingRecord,
	verdictRecord,
} from "./checkpoint-writers.ts";
import type {
	CheckpointOpenOptions,
	CheckpointPrior,
	CheckpointStore,
	IssueIntent,
	IssueRecord,
} from "./ports.ts";
import type { TestDefinition, Verdict } from "./types.ts";

export { CheckpointLockError, CheckpointMismatchError } from "./checkpoint-errors.ts";
export { readCheckpointRecords } from "./checkpoint-reader.ts";

/**
 * JSONL checkpoint store. Single writer: `open` takes a lock on the checkpoint
 * path and holds it until `close`, and every append goes through this instance.
 */
export class JsonlCheckpointStore implements CheckpointStore {
	#path: string | null = null;
	#unlock: (() => Promise<void>) | null = null;
	#records: CheckpointRecord[] = [];
	#prior: CheckpointPrior = emptyPrior(null);
	#closed = false;

	#defaultPath: string | null;

	constructor(defaultPath?: string) {
		this.#defaultPath = defaultPath ?? null;
	}

	async open(options: CheckpointOpenOptions): Promise<CheckpointPrior> {
		const path = options.path ?? this.#defaultPath;
		if (path === null) {
			throw new CheckpointError(
				"checkpoint path is not configured (pass it to the constructor or open())",
			);
		}
		const now = options.now ?? (() => new Date());
		mkdirSync(dirname(path), { recursive: true });

		const archivePath = options.restart ? archivePrevious(path, now()) : null;
		if (!existsSync(path)) writeFileSync(path, "", "utf8");

		try {
			this.#unlock = await lockfile.lock(path, { realpath: false, retries: 0, stale: 120_000 });
		} catch (err) {
			throw new CheckpointLockError(
				`checkpoint is locked by another run: ${path} (${err instanceof Error ? err.message : String(err)})`,
			);
		}

		this.#path = path;
		try {
			this.#prior = this.#load(options, path, archivePath, now);
			return this.#prior;
		} catch (err) {
			await this.#release();
			throw err;
		}
	}

	/** Adopt the existing header, or write a fresh one for this run. */
	#load(
		options: CheckpointOpenOptions,
		path: string,
		archivePath: string | null,
		now: () => Date,
	): CheckpointPrior {
		const records = readCheckpointRecords(path);
		const header = records.find(
			(record): record is CheckpointHeaderRecord => record.type === "header",
		);

		if (!header) {
			this.#records = [
				{
					type: "header",
					schemaVersion: CHECKPOINT_SCHEMA_VERSION,
					inventoryFingerprint: options.inventoryFingerprint,
					configFingerprint: options.configFingerprint,
					criteriaSha256: options.criteriaSha256,
					createdAt: now().toISOString(),
				},
			];
			appendFileSync(path, `${JSON.stringify(this.#records[0])}\n`, "utf8");
			return emptyPrior(archivePath);
		}

		if (header.inventoryFingerprint !== options.inventoryFingerprint) {
			throw new CheckpointMismatchError("inventory", inventoryDrift(records, options.definitions));
		}
		if (header.configFingerprint !== options.configFingerprint) {
			throw new CheckpointMismatchError("config", inventoryDrift(records, options.definitions));
		}
		this.#records = records;
		return { ...summarize(records), resumed: true, archivePath };
	}

	async appendVerdict(def: TestDefinition, verdict: Verdict): Promise<void> {
		await this.#append(verdictRecord(def, verdict));
	}

	async appendPending(
		def: TestDefinition,
		outcome: { readonly attempts: number; readonly pendingReason: string },
	): Promise<void> {
		await this.#append(pendingRecord(def, outcome));
	}

	async recordIssueIntent(intent: IssueIntent): Promise<void> {
		await this.#append(issueIntentRecord(intent));
	}

	async recordIssue(issue: IssueRecord): Promise<void> {
		await this.#append(issueRecord(issue));
	}

	/** Latest known verdict per test key, including appends made this session. */
	verdicts(): ReadonlyMap<string, Verdict> {
		return summarize(this.#records).verdicts;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#release();
	}

	async #append(record: CheckpointRecord): Promise<void> {
		const path = this.#path;
		if (path === null || this.#closed) {
			throw new CheckpointError("checkpoint is not open");
		}
		try {
			appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
			this.#records = [...this.#records, record];
		} catch (err) {
			// Fail closed: release the lock so the operator can inspect and rerun.
			await this.#release();
			throw new CheckpointError(
				`checkpoint append failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async #release(): Promise<void> {
		const unlock = this.#unlock;
		this.#unlock = null;
		if (!unlock) return;
		try {
			await unlock();
		} catch {
			// The lock file may already be gone; releasing is best effort and the
			// caller's error (if any) is the one that matters.
		}
	}
}
