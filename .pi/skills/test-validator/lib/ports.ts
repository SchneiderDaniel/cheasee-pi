// Ports owned by the `runValidation` use case. Kept in their own module so the
// adapters (pi-ai model, JSONL checkpoint, gh filer) can implement them without
// importing the use case, and the use case never imports an adapter.
//
// Only `run.ts` consumes these interfaces; everything they exchange is pure data.

import type { DecisionRequest, TestDefinition, Verdict } from "./types.ts";

/** One isolated, tool-less model call with fresh context. */
export interface DecisionModel {
	/** Returns the model's raw text. Interpretation belongs to `decision.ts`. */
	decide(request: DecisionRequest): Promise<string>;
}

/** How the run streams progress to the operator. */
export interface RunLogger {
	(line: string): void;
}

/** A filing intent, written before the issue exists so resume can search for it. */
export interface IssueIntent {
	readonly runFingerprint: string;
	readonly title: string;
}

/** A filed cleanup issue. */
export interface IssueRecord {
	readonly runFingerprint: string;
	readonly url: string;
}

/** What a resumed checkpoint still knows. */
export interface CheckpointPrior {
	/** True when a header for the same inventory and config was found. */
	readonly resumed: boolean;
	/** Where a `--restart` moved the previous file, or null. */
	readonly archivePath: string | null;
	/** Decided verdicts by test key (GOOD/BAD only), all re-checked against the gate. */
	readonly verdicts: ReadonlyMap<string, Verdict>;
	/** Attempt counts by test key, from pending records. */
	readonly attempts: ReadonlyMap<string, number>;
	/** Stored BAD decisions the gate refused; they must be judged again. */
	readonly rejected: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
	readonly issueIntent: IssueIntent | null;
	readonly issue: IssueRecord | null;
}

/** Options for acquiring a checkpoint, including the resume guard. */
export interface CheckpointOpenOptions {
	/**
	 * Overrides the path the store was constructed with. The port leaves it
	 * optional so the use case never needs to know a file location.
	 */
	readonly path?: string;
	readonly restart?: boolean;
	/** Fingerprint of the inventory the caller is about to judge. */
	readonly inventoryFingerprint: string;
	readonly configFingerprint: string;
	readonly criteriaSha256: string;
	/** Current inventory, used to report add/remove/modify counts on refusal. */
	readonly definitions: readonly TestDefinition[];
	/**
	 * Source text by repository-relative path. A stored BAD verdict is re-checked
	 * against the current judged slice, so the store needs the source it judged.
	 */
	readonly sources: ReadonlyMap<string, string>;
	/** BAD gate threshold a replayed verdict must still meet. */
	readonly badConfidenceThreshold: number;
	/** Injectable clock, so archive names and timestamps stay deterministic. */
	readonly now?: () => Date;
}

/** Append-only store with a single writer. */
export interface CheckpointStore {
	open(options: CheckpointOpenOptions): Promise<CheckpointPrior>;
	appendVerdict(def: TestDefinition, verdict: Verdict): Promise<void>;
	appendPending(
		def: TestDefinition,
		outcome: { readonly attempts: number; readonly pendingReason: string },
	): Promise<void>;
	recordIssueIntent(intent: IssueIntent): Promise<void>;
	recordIssue(issue: IssueRecord): Promise<void>;
	close(): Promise<void>;
}

/** The GitHub seam: create exactly one cleanup issue, and find a lost one. */
export interface IssueFiler {
	create(input: {
		readonly title: string;
		readonly body: string;
	}): Promise<{ readonly url: string }>;
	search(input: { readonly runFingerprint: string }): Promise<IssueRecord | null>;
}
