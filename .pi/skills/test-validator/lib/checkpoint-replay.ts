// Adapter: replay checkpoint records into the state a resumed run needs.
//
// Last write wins per test: a verdict after a pending replaces it, a later
// verdict replaces an earlier one. Replay is pure, so resume behaviour is decided
// by the records alone and never by the order the process happened to append.

import { isTestRecord, type CheckpointRecord } from "./checkpoint-records.ts";
import type { CheckpointPrior, IssueIntent, IssueRecord } from "./ports.ts";
import { testKey } from "./types.ts";
import type { TestDefinition, TestLanguage, Verdict } from "./types.ts";

/** Identity of a definition, as every per-test record stores it. */
export function identityOf(def: TestDefinition): {
	readonly file: string;
	readonly name: string;
	readonly language: TestLanguage;
	readonly startLine: number;
	readonly endLine: number;
	readonly sourceSha256: string;
} {
	return {
		file: def.file,
		name: def.name,
		language: def.language,
		startLine: def.startLine,
		endLine: def.endLine,
		sourceSha256: def.sourceSha256,
	};
}

/** The empty prior a fresh checkpoint reports. */
export function emptyPrior(archivePath: string | null): CheckpointPrior {
	return {
		resumed: false,
		archivePath,
		verdicts: new Map(),
		attempts: new Map(),
		rejected: [],
		issueIntent: null,
		issue: null,
	};
}

function verdictOf(record: {
	readonly decision: "GOOD" | "BAD";
	readonly confidence: number;
	readonly criteria: readonly string[];
	readonly reason: string;
	readonly evidence: readonly { readonly line: number; readonly quote: string }[];
}): Verdict {
	return {
		decision: record.decision,
		confidence: record.confidence,
		criteria: [...record.criteria],
		reason: record.reason,
		evidence: record.evidence.map((entry) => ({ line: entry.line, quote: entry.quote })),
		pendingReason: "",
	};
}

/** Replay records into the latest state: the last record per test wins. */
export function summarize(records: readonly CheckpointRecord[]): {
	verdicts: Map<string, Verdict>;
	attempts: Map<string, number>;
	issueIntent: IssueIntent | null;
	issue: IssueRecord | null;
} {
	const verdicts = new Map<string, Verdict>();
	const attempts = new Map<string, number>();
	let issueIntent: IssueIntent | null = null;
	let issue: IssueRecord | null = null;

	for (const record of records) {
		if (record.type === "verdict") {
			verdicts.set(testKey(record), verdictOf(record));
		} else if (record.type === "pending") {
			attempts.set(testKey(record), record.attempts);
		} else if (record.type === "issue-intent") {
			issueIntent = { runFingerprint: record.runFingerprint, title: record.title };
		} else if (record.type === "issue") {
			issue = { runFingerprint: record.runFingerprint, url: record.url };
		}
	}

	return { verdicts, attempts, issueIntent, issue };
}

/** Compare the checkpoint's judged inventory with the caller's current one. */
export function inventoryDrift(
	records: readonly CheckpointRecord[],
	definitions: readonly TestDefinition[],
): { readonly added: number; readonly removed: number; readonly modified: number } {
	const prior = new Map<string, string>();
	for (const record of records) {
		if (isTestRecord(record)) prior.set(testKey(record), record.sourceSha256);
	}
	const current = new Map<string, string>();
	for (const def of definitions) current.set(testKey(def), def.sourceSha256);

	let added = 0;
	let removed = 0;
	let modified = 0;
	for (const [key, sha] of current) {
		const before = prior.get(key);
		if (before === undefined) added += 1;
		else if (before !== sha) modified += 1;
	}
	for (const key of prior.keys()) {
		if (!current.has(key)) removed += 1;
	}
	return { added, removed, modified };
}
