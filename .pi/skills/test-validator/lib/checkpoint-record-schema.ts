// Adapter: validate the two per-test record kinds before a resume replays them.
//
// A tampered `decision`, a missing `reason`, or an unknown criterion id would
// otherwise come back as a completed verdict and let a partial audit report
// itself complete, so every field is checked here.

import {
	criteriaField,
	evidenceField,
	identityFields,
	intField,
	refuse,
	textField,
} from "./checkpoint-fields.ts";
import type { CheckpointPendingRecord, CheckpointVerdictRecord } from "./checkpoint-records.ts";

/** A stored decision plus the evidence that produced it. */
export function verdictRecord(
	where: string,
	raw: Record<string, unknown>,
): CheckpointVerdictRecord {
	const base = identityFields(where, raw);
	if (raw.decision !== "GOOD" && raw.decision !== "BAD") {
		refuse(where, 'decision must be "GOOD" or "BAD"');
	}
	const confidence = raw.confidence;
	if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
		refuse(where, "confidence must be a finite number");
	}
	if (confidence < 0 || confidence > 1) refuse(where, "confidence must be inside [0, 1]");
	return {
		...base,
		type: "verdict",
		decision: raw.decision,
		confidence,
		criteria: criteriaField(where, raw.criteria),
		reason: textField(where, "reason", raw.reason),
		evidence: evidenceField(where, raw.evidence),
		recordedAt: textField(where, "recordedAt", raw.recordedAt),
	};
}

/** An attempt that never reached a decision; replayed as its attempt count. */
export function pendingRecord(
	where: string,
	raw: Record<string, unknown>,
): CheckpointPendingRecord {
	return {
		...identityFields(where, raw),
		type: "pending",
		attempts: intField(where, "attempts", raw.attempts, 0),
		pendingReason: textField(where, "pendingReason", raw.pendingReason),
		recordedAt: textField(where, "recordedAt", raw.recordedAt),
	};
}
