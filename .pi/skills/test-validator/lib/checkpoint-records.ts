// Adapter: the on-disk JSONL record shapes.
//
// Line 1 of a checkpoint is a header carrying the inventory/config fingerprints,
// then one record per event (`verdict`, `pending`, `issue-intent`, `issue`). The
// latest record per test wins, so a re-judged test simply appends. Reading lives
// in `checkpoint-reader.ts`, replay in `checkpoint-replay.ts`.

import type { TestLanguage, VerdictEvidence } from "./types.ts";

/** Bumped when the on-disk record shape changes; an old header is refused. */
export const CHECKPOINT_SCHEMA_VERSION = 2;

/** Identity fields every per-test record carries. */
interface TestIdentity {
	readonly file: string;
	readonly name: string;
	readonly language: TestLanguage;
	readonly startLine: number;
	readonly endLine: number;
	readonly sourceSha256: string;
}

export interface CheckpointHeaderRecord {
	readonly type: "header";
	readonly schemaVersion: number;
	readonly inventoryFingerprint: string;
	readonly configFingerprint: string;
	readonly criteriaSha256: string;
	readonly createdAt: string;
}

export interface CheckpointVerdictRecord extends TestIdentity {
	readonly type: "verdict";
	readonly decision: "GOOD" | "BAD";
	readonly confidence: number;
	readonly criteria: readonly string[];
	readonly reason: string;
	readonly evidence: readonly VerdictEvidence[];
	readonly recordedAt: string;
}

export interface CheckpointPendingRecord extends TestIdentity {
	readonly type: "pending";
	readonly attempts: number;
	readonly pendingReason: string;
	readonly recordedAt: string;
}

export interface CheckpointIssueIntentRecord {
	readonly type: "issue-intent";
	readonly runFingerprint: string;
	readonly title: string;
	readonly recordedAt: string;
}

export interface CheckpointIssueRecord {
	readonly type: "issue";
	readonly runFingerprint: string;
	readonly url: string;
	readonly recordedAt: string;
}

export type CheckpointRecord =
	| CheckpointHeaderRecord
	| CheckpointVerdictRecord
	| CheckpointPendingRecord
	| CheckpointIssueIntentRecord
	| CheckpointIssueRecord;

/** Plain object check: arrays and null are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The record kinds this schema version knows. */
export const CHECKPOINT_RECORD_TYPES: readonly CheckpointRecord["type"][] = [
	"header",
	"verdict",
	"pending",
	"issue-intent",
	"issue",
];

/** Per-test records, the only ones that carry an identity. */
export function isTestRecord(
	record: CheckpointRecord,
): record is CheckpointVerdictRecord | CheckpointPendingRecord {
	return record.type === "verdict" || record.type === "pending";
}
