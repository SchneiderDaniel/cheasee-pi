// Adapter: build the record a store method appends.
//
// Pure factories, so the store only decides *when* to append and never how a
// verdict, a pending outcome, or an issue is spelled on disk.

import { CheckpointError } from "./checkpoint-errors.ts";
import type {
	CheckpointIssueIntentRecord,
	CheckpointIssueRecord,
	CheckpointPendingRecord,
	CheckpointVerdictRecord,
} from "./checkpoint-records.ts";
import { identityOf } from "./checkpoint-replay.ts";
import type { IssueIntent, IssueRecord } from "./ports.ts";
import { testKey } from "./types.ts";
import type { TestDefinition, Verdict } from "./types.ts";

/** A decided verdict record. Refuses to record a pending verdict as a decision. */
export function verdictRecord(def: TestDefinition, verdict: Verdict): CheckpointVerdictRecord {
	if (verdict.decision !== "GOOD" && verdict.decision !== "BAD") {
		throw new CheckpointError(
			`refusing to record an undecided verdict for ${testKey(def)} as a decision`,
		);
	}
	return {
		type: "verdict",
		...identityOf(def),
		decision: verdict.decision,
		confidence: verdict.confidence,
		criteria: [...verdict.criteria],
		reason: verdict.reason,
		evidence: verdict.evidence.map((entry) => ({ line: entry.line, quote: entry.quote })),
		recordedAt: new Date().toISOString(),
	};
}

/** One attempt that did not reach a decision. */
export function pendingRecord(
	def: TestDefinition,
	outcome: { readonly attempts: number; readonly pendingReason: string },
): CheckpointPendingRecord {
	return {
		type: "pending",
		...identityOf(def),
		attempts: outcome.attempts,
		pendingReason: outcome.pendingReason,
		recordedAt: new Date().toISOString(),
	};
}

/** Written before the create call, so a crash leaves a searchable marker. */
export function issueIntentRecord(intent: IssueIntent): CheckpointIssueIntentRecord {
	return {
		type: "issue-intent",
		runFingerprint: intent.runFingerprint,
		title: intent.title,
		recordedAt: new Date().toISOString(),
	};
}

export function issueRecord(issue: IssueRecord): CheckpointIssueRecord {
	return {
		type: "issue",
		runFingerprint: issue.runFingerprint,
		url: issue.url,
		recordedAt: new Date().toISOString(),
	};
}
