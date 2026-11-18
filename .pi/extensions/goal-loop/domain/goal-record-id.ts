// ─── Goal record identity: ids and fresh records ─────────────────
// Pure. `makeGoalId` builds `yyyymmdd-hhmmss-<slug>-<rand4>`; the suffix is
// seeded per process, so two records created in the same second still differ.
//
// `assertSafeGoalId` runs before any path is built, so a hostile id cannot
// escape the record directory (R2.AC4).

import type { GoalConfigSnapshot, GoalRecord } from "./goal-record.ts";

/** Longest slug retained in a record id. */
const MAX_SLUG_LENGTH = 50;

/** Base36 space for the 4-character id suffix. */
const ID_SUFFIX_SPACE = 1_679_616;

const SEED = Math.floor(Math.random() * ID_SUFFIX_SPACE);
let suffixSequence = 0;

/**
 * A 4-character suffix. Seeded per process, advanced per call, so two records
 * created in the same second (or millisecond) always differ.
 */
function defaultSuffix(): string {
	suffixSequence += 1;
	const n = (SEED + suffixSequence) % ID_SUFFIX_SPACE;
	return n.toString(36).padStart(4, "0").slice(-4);
}

/** Lowercase slug: `[a-z0-9]` runs joined by `-`, truncated to 50 chars. */
export function slugifyGoalDescription(description: string): string {
	const slug = description
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/-+$/, "");
	return slug || "goal";
}

/** `yyyymmdd-hhmmss` in UTC. */
function timestampId(now: Date): string {
	const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
	return (
		`${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
		`-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
	);
}

/** Reject an id that could escape the record directory before any I/O. */
export function assertSafeGoalId(id: string): void {
	if (!id.trim()) throw new Error("goal id must not be empty");
	if (id.includes("/") || id.includes("\\")) {
		throw new Error(`goal id "${id}" must not contain a path separator`);
	}
	if (id.includes("..")) {
		throw new Error(`goal id "${id}" must not contain ".."`);
	}
	if (id.startsWith(".")) {
		throw new Error(`goal id "${id}" must not start with "."`);
	}
}

/**
 * Build a unique goal id: `yyyymmdd-hhmmss-<slug>-<rand4>`.
 *
 * `random` is injectable so tests can assert the format deterministically.
 */
export function makeGoalId(
	description: string,
	now: Date = new Date(),
	random: () => string = defaultSuffix,
): string {
	const id = `${timestampId(now)}-${slugifyGoalDescription(description)}-${random()}`;
	assertSafeGoalId(id);
	return id;
}

/**
 * A fresh record for `/goal <request>`: `clarifying`, no iterations, no
 * worktree/branch/PR, config snapshotted.
 */
export function createGoalRecord(input: {
	id: string;
	request: string;
	config: GoalConfigSnapshot;
	now?: Date;
}): GoalRecord {
	assertSafeGoalId(input.id);
	if (!input.request.trim()) throw new Error("goal request must not be empty");
	const now = input.now ?? new Date();
	return {
		id: input.id,
		status: "clarifying",
		request: input.request,
		clarifiedGoal: "",
		criteria: [],
		verification: [],
		iterations: 0,
		windowIterations: 0,
		resets: 0,
		generation: 0,
		lastCheckpoint: now.toISOString(),
		nextAction: "",
		config: { ...input.config },
		worktree: null,
		branch: null,
		pr: null,
		blocker: null,
		steering: [],
		compactionSeen: false,
		inFlight: false,
	};
}
