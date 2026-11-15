// Adapter: append-only JSONL checkpoint on disk.
//
// One file per audit. `open` takes a lock and holds it until `close`, so exactly
// one process writes; every append is a single `appendFileSync`, so a crash can
// only tear the tail. Record shapes live in `checkpoint-records.ts`, the reader
// in `checkpoint-reader.ts`, replay in `checkpoint-replay.ts`, archiving in
// `checkpoint-archive.ts`, and the failures in `checkpoint-errors.ts`.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { archivePrevious } from "./checkpoint-archive.ts";
import { CheckpointError, CheckpointMismatchError } from "./checkpoint-errors.ts";
import { acquireCheckpointLock, releaseCheckpointLock, type Unlock } from "./checkpoint-lock.ts";
import { readCheckpointRecords, terminateTornTail } from "./checkpoint-reader.ts";
import { CHECKPOINT_SCHEMA_VERSION, type CheckpointRecord } from "./checkpoint-records.ts";
import { emptyPrior, inventoryDrift, summarize } from "./checkpoint-replay.ts";
import { revalidateStoredVerdicts } from "./checkpoint-verdict-gate.ts";
import {
	headerRecord,
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
import { testKey } from "./types.ts";

export {
	CheckpointError,
	CheckpointLockError,
	CheckpointMismatchError,
	CheckpointSchemaError,
} from "./checkpoint-errors.ts";
export { CHECKPOINT_SCHEMA_VERSION } from "./checkpoint-records.ts";
export { readCheckpointRecords } from "./checkpoint-reader.ts";

/**
 * JSONL checkpoint store. Single writer: `open` takes a lock on the checkpoint
 * path and holds it until `close`, and every append goes through this instance.
 */
export class JsonlCheckpointStore implements CheckpointStore {
	#path: string | null = null;
	#unlock: Unlock | null = null;
	#records: CheckpointRecord[] = [];
	#verdicts = new Map<string, Verdict>();
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

		this.#unlock = await acquireCheckpointLock(path);

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
		const header = records[0];

		if (header === undefined) {
			terminateTornTail(path);
			this.#records = [headerRecord(options, now())];
			this.#verdicts = new Map();
			appendFileSync(path, `${JSON.stringify(this.#records[0])}\n`, "utf8");
			return emptyPrior(archivePath);
		}

		if (header.type !== "header") {
			throw new CheckpointError(
				`checkpoint has no header record at ${path}:1; it cannot be trusted (rerun with --restart to archive it)`,
			);
		}

		if (header.inventoryFingerprint !== options.inventoryFingerprint) {
			throw new CheckpointMismatchError("inventory", inventoryDrift(records, options.definitions));
		}
		if (header.configFingerprint !== options.configFingerprint) {
			throw new CheckpointMismatchError("config", inventoryDrift(records, options.definitions));
		}
		this.#records = records;
		// Shape validation happens on read (`checkpoint-schema.ts`). Policy is
		// re-applied here: a stored BAD verdict that no longer satisfies the gate
		// is refused rather than replayed, so a resume cannot report a false BAD.
		const summary = summarize(records);
		const gated = revalidateStoredVerdicts({
			verdicts: summary.verdicts,
			definitions: options.definitions,
			sources: options.sources,
			badConfidenceThreshold: options.badConfidenceThreshold,
		});
		this.#verdicts = gated.verdicts;
		return {
			...summary,
			verdicts: gated.verdicts,
			rejected: gated.rejected,
			resumed: true,
			archivePath,
		};
	}

	async appendVerdict(def: TestDefinition, verdict: Verdict): Promise<void> {
		await this.#append(verdictRecord(def, verdict));
		this.#verdicts.set(testKey(def), verdict);
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
		return this.#verdicts;
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
		await releaseCheckpointLock(unlock);
	}
}
