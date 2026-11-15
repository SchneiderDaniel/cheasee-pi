// Shared fixtures for the JSONL checkpoint adapter tests: temp directories,
// definition/verdict factories, and the open options a caller would build.
// Not a `*.test.mts`, so the runner never executes it as a suite.

// Phase 4 — append-only JSONL checkpoint: header fingerprint guard, torn-tail
// recovery, mid-file corruption that halts, archive-on-restart, and a lock that
// admits exactly one writer.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CheckpointLockError,
	CheckpointMismatchError,
	JsonlCheckpointStore,
	readCheckpointRecords,
} from "../../lib/checkpoint.ts";
import { inventoryFingerprint } from "../../lib/fingerprint.ts";
import type { TestDefinition, Verdict } from "../../lib/types.ts";

export const CONFIG_HASH = "2".repeat(64);
export const CRITERIA_HASH = "3".repeat(64);

export function def(overrides: Partial<TestDefinition> = {}): TestDefinition {
	return {
		file: "src/a.test.mts",
		name: "keeps total",
		startLine: 5,
		endLine: 8,
		sourceSha256: "d".repeat(64),
		...overrides,
	};
}

export function goodVerdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		decision: "GOOD",
		confidence: 0.91,
		criteria: ["C2"],
		reason: "asserts observable behaviour",
		evidence: [{ line: 6, quote: "assert.equal(total, 2);" }],
		pendingReason: "",
		...overrides,
	};
}

export interface Ctx {
	dir: string;
	path: string;
}

export async function withTempDir(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "test-validator-"));
	try {
		await fn({ dir, path: join(dir, "checkpoint.jsonl") });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Fingerprint of the inventory a session is about to judge (as the CLI does). */
export const INVENTORY_HASH = inventoryFingerprint([def()]);

export function openOptions(ctx: Ctx, overrides: Record<string, unknown> = {}) {
	return {
		path: ctx.path,
		inventoryFingerprint: INVENTORY_HASH,
		configFingerprint: CONFIG_HASH,
		criteriaSha256: CRITERIA_HASH,
		definitions: [def()],
		...overrides,
	};
}

/** Raw record lines on disk, parsed, for assertions about the file shape. */
export function readLines(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}
