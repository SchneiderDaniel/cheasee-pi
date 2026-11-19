// ─── Goal record parsing: fail-closed front-matter reader ────────
// Pure. A truncated front matter, a missing required key, a value that is not
// valid JSON, or an unknown `status` each return an error — nothing is
// defaulted or coerced, because a silently repaired record would let the loop
// resume from state the user never approved (R2.AC4).

import { failure, type Result } from "../../shared/result.ts";
import { GOAL_STATUSES, type GoalRecord, type GoalStatus } from "./goal-record.ts";
import { FRONT_MATTER_KEYS } from "./goal-record-markdown.ts";
import { assertSafeGoalId } from "./goal-record-id.ts";
import { buildRecord, type RawFields } from "./goal-record-fields.ts";

const SOURCE = "goal-record";
const STATUS_SET = new Set<string>(GOAL_STATUSES);

/** Split a record document into its front-matter lines and the body. */
function splitFrontMatter(text: string): Result<{ lines: string[]; body: string }> {
	const normalised = text.replace(/\r\n/g, "\n");
	if (!normalised.startsWith("---\n")) {
		return failure("missing front matter (file must start with '---')", SOURCE);
	}
	const end = normalised.indexOf("\n---", 3);
	if (end < 0) {
		return failure("truncated front matter (no closing '---')", SOURCE);
	}
	const lines = normalised.slice(4, end).split("\n");
	const body = normalised.slice(end + 4);
	return { ok: true, value: { lines, body } };
}

/**
 * Read one front-matter line into the map. Returns a failure naming the line
 * when it is not `key: <json>`.
 */
function readLine(line: string, raw: RawFields): Result<void> {
	const match = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
	if (!match) {
		return failure(`malformed front-matter line: "${line.slice(0, 60)}"`, SOURCE);
	}
	const [, key, value] = match as unknown as [string, string, string];
	try {
		raw.set(key, JSON.parse(value));
	} catch {
		return failure(`front-matter key "${key}" is not valid JSON`, SOURCE);
	}
	return { ok: true, value: undefined };
}

/**
 * Parse a record document. Fail-closed on every malformed input; the caller
 * (the store adapter) prefixes the failure with the file path.
 */
export function parseGoalRecord(text: string): Result<GoalRecord> {
	const split = splitFrontMatter(text);
	if (!split.ok) return split;

	const raw: RawFields = new Map();
	for (const line of split.value.lines) {
		if (line.trim() === "") continue;
		const read = readLine(line, raw);
		if (!read.ok) return read;
	}

	for (const key of FRONT_MATTER_KEYS) {
		if (!raw.has(key)) {
			return failure(`missing required front-matter key "${key}"`, SOURCE);
		}
	}

	const status = raw.get("status");
	if (typeof status !== "string" || !STATUS_SET.has(status)) {
		return failure(`unknown goal status "${String(status)}"`, SOURCE);
	}

	const id = raw.get("id");
	if (typeof id !== "string") return failure('front-matter key "id" must be a string', SOURCE);
	try {
		assertSafeGoalId(id);
	} catch (err: unknown) {
		return failure(err instanceof Error ? err.message : String(err), SOURCE);
	}

	try {
		return { ok: true, value: buildRecord(raw, id, status as GoalStatus) };
	} catch (err: unknown) {
		return failure(err instanceof Error ? err.message : String(err), SOURCE);
	}
}
