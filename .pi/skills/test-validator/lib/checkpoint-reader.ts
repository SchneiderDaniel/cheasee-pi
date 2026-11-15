// Adapter: read a JSONL checkpoint, tolerating exactly one kind of damage.
//
// A file that was interrupted mid-append has no trailing newline on its last
// line; that partial JSON is dropped and the test it described is judged again.
// Any other unparsable line is corruption, not truncation — the accounting is
// broken, so the read throws and the run halts.
//
// Every line that does parse is then validated against the record schema in
// `checkpoint-schema.ts`: a JSON object that is not a well-formed record must
// never be replayed as a decision.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { CheckpointError } from "./checkpoint-errors.ts";
import type { CheckpointRecord } from "./checkpoint-records.ts";
import { parseCheckpointRecord } from "./checkpoint-schema.ts";

/**
 * Terminate a torn tail so the next appended line stays its own record.
 * A crash mid-append leaves the last line unterminated.
 */
export function terminateTornTail(path: string): void {
	const existing = readFileSync(path, "utf8");
	if (existing !== "" && !existing.endsWith("\n")) appendFileSync(path, "\n", "utf8");
}

function corrupt(path: string, index: number, why: string): CheckpointError {
	return new CheckpointError(`corrupt checkpoint record at ${path}:${index + 1}: ${why}`);
}

/**
 * Read and validate every record of `path`, discarding only a torn final line.
 *
 * @param path checkpoint file; a missing file reads as no records
 */
export function readCheckpointRecords(path: string): CheckpointRecord[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	if (text === "") return [];

	const terminated = text.endsWith("\n");
	const parts = text.split("\n");
	if (terminated) parts.pop();

	const records: CheckpointRecord[] = [];
	for (let index = 0; index < parts.length; index += 1) {
		const line = parts[index];
		const isTornTail = index === parts.length - 1 && !terminated;
		if (line.trim() === "") {
			if (isTornTail) continue;
			throw corrupt(path, index, "empty line");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			if (isTornTail) continue;
			throw corrupt(path, index, "invalid JSON");
		}
		records.push(parseCheckpointRecord(parsed, `${path}:${index + 1}`));
	}
	return records;
}
