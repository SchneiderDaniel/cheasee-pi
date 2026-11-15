// Adapter: validate a checkpoint record before replay trusts it.
//
// A line that parses as JSON is not enough. One tampered `decision` field would
// otherwise be replayed as a completed verdict, and a partial audit would report
// itself complete. `parseCheckpointRecord` is the single entry point; the field
// validators live in `checkpoint-fields.ts`, the per-test record kinds in
// `checkpoint-record-schema.ts`.

import { hexField, refuse, textField } from "./checkpoint-fields.ts";
import { pendingRecord, verdictRecord } from "./checkpoint-record-schema.ts";
import {
	CHECKPOINT_RECORD_TYPES,
	CHECKPOINT_SCHEMA_VERSION,
	isRecord,
	type CheckpointHeaderRecord,
	type CheckpointIssueIntentRecord,
	type CheckpointIssueRecord,
	type CheckpointRecord,
} from "./checkpoint-records.ts";

function headerRecord(where: string, raw: Record<string, unknown>): CheckpointHeaderRecord {
	if (raw.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
		const found = String(raw.schemaVersion);
		refuse(
			where,
			`schema version ${found} is not the supported version ${CHECKPOINT_SCHEMA_VERSION}`,
		);
	}
	return {
		type: "header",
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		inventoryFingerprint: hexField(where, "inventoryFingerprint", raw.inventoryFingerprint),
		configFingerprint: hexField(where, "configFingerprint", raw.configFingerprint),
		criteriaSha256: hexField(where, "criteriaSha256", raw.criteriaSha256),
		createdAt: textField(where, "createdAt", raw.createdAt),
	};
}

function issueIntentRecord(
	where: string,
	raw: Record<string, unknown>,
): CheckpointIssueIntentRecord {
	return {
		type: "issue-intent",
		runFingerprint: hexField(where, "runFingerprint", raw.runFingerprint),
		title: textField(where, "title", raw.title),
		recordedAt: textField(where, "recordedAt", raw.recordedAt),
	};
}

function issueRecord(where: string, raw: Record<string, unknown>): CheckpointIssueRecord {
	return {
		type: "issue",
		runFingerprint: hexField(where, "runFingerprint", raw.runFingerprint),
		url: textField(where, "url", raw.url),
		recordedAt: textField(where, "recordedAt", raw.recordedAt),
	};
}

/**
 * Validate one parsed checkpoint line.
 *
 * @param value the `JSON.parse` result of one line
 * @param where `path:line` for the error message
 * @throws CheckpointSchemaError when the value is not a record this version knows
 */
export function parseCheckpointRecord(value: unknown, where: string): CheckpointRecord {
	if (!isRecord(value)) refuse(where, "checkpoint record is not an object");
	const type = value.type;
	if (typeof type !== "string" || !CHECKPOINT_RECORD_TYPES.includes(type as never)) {
		const known = CHECKPOINT_RECORD_TYPES.join(", ");
		refuse(where, `unknown record type ${JSON.stringify(type)}; expected one of ${known}`);
	}
	switch (type) {
		case "header":
			return headerRecord(where, value);
		case "verdict":
			return verdictRecord(where, value);
		case "pending":
			return pendingRecord(where, value);
		case "issue-intent":
			return issueIntentRecord(where, value);
		default:
			return issueRecord(where, value);
	}
}
