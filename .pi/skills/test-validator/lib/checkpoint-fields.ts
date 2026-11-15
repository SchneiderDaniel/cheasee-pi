// Adapter: the primitive field validators behind `checkpoint-schema.ts`.
//
// Each helper throws `CheckpointSchemaError` naming the file:line it read, so a
// refusal always points at the record an operator has to inspect.

import { CheckpointSchemaError } from "./checkpoint-errors.ts";
import { CRITERIA_IDS } from "./decision.ts";
import { TEST_LANGUAGES } from "./types.ts";
import type { TestLanguage, VerdictEvidence } from "./types.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const CRITERIA = new Set(CRITERIA_IDS);

export function refuse(where: string, why: string): never {
	throw new CheckpointSchemaError(where, why);
}

export function textField(where: string, field: string, value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") {
		refuse(where, `${field} must be a non-empty string`);
	}
	return value;
}

export function hexField(where: string, field: string, value: unknown): string {
	if (typeof value !== "string" || !HEX64.test(value)) {
		refuse(where, `${field} must be a 64-character lowercase hex sha256`);
	}
	return value;
}

export function intField(where: string, field: string, value: unknown, min: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		refuse(where, `${field} must be an integer >= ${min}`);
	}
	return value;
}

export interface CheckpointIdentity {
	readonly file: string;
	readonly name: string;
	readonly language: TestLanguage;
	readonly startLine: number;
	readonly endLine: number;
	readonly sourceSha256: string;
}

/** `file`, `name`, `language`, and the inclusive line range of a per-test record. */
export function identityFields(where: string, raw: Record<string, unknown>): CheckpointIdentity {
	if (typeof raw.language !== "string" || !TEST_LANGUAGES.includes(raw.language as TestLanguage)) {
		refuse(where, `language must be one of ${TEST_LANGUAGES.join(", ")}`);
	}
	const startLine = intField(where, "startLine", raw.startLine, 1);
	const endLine = intField(where, "endLine", raw.endLine, 1);
	if (endLine < startLine) refuse(where, "endLine must be >= startLine");
	return {
		file: textField(where, "file", raw.file),
		name: textField(where, "name", raw.name),
		language: raw.language as TestLanguage,
		startLine,
		endLine,
		sourceSha256: hexField(where, "sourceSha256", raw.sourceSha256),
	};
}

export function criteriaField(where: string, raw: unknown): string[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		refuse(where, `criteria must be a non-empty array of ids (${[...CRITERIA].join(", ")})`);
	}
	const ids: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string" || !CRITERIA.has(item)) {
			refuse(where, `criteria must only contain known ids (${[...CRITERIA].join(", ")})`);
		}
		ids.push(item);
	}
	return ids;
}

/**
 * Evidence entries are validated for shape only: the BAD gate demanded an
 * in-range quote when the verdict was made, while a GOOD verdict may cite a line
 * outside the slice. A range check here would refuse a legitimate checkpoint.
 */
export function evidenceField(where: string, raw: unknown): VerdictEvidence[] {
	if (!Array.isArray(raw)) refuse(where, "evidence must be an array");
	const entries: VerdictEvidence[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			refuse(where, "evidence entries must be objects carrying line plus quote");
		}
		const entry = item as Record<string, unknown>;
		entries.push({
			line: intField(where, "evidence.line", entry.line, 1),
			quote: textField(where, "evidence.quote", entry.quote),
		});
	}
	return entries;
}
