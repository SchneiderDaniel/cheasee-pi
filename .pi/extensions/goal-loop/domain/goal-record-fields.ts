// ─── Goal record field readers ───────────────────────────────────
// Pure coercion helpers behind `parseGoalRecord`. Each one throws a message
// naming its key, so the caller keeps a single try/catch instead of one per
// field and the failure text still points at the offending line.

import type {
	AcceptanceCriterion,
	GoalConfigSnapshot,
	GoalPullRequest,
	GoalRecord,
	VerificationResult,
} from "./goal-record.ts";
import type { GoalStatus } from "./goal-record.ts";

/** `raw` is a key → JSON value map built from the front matter. */
export type RawFields = Map<string, unknown>;

/** Assemble the typed record, converting any shape violation into a throw. */
export function buildRecord(raw: RawFields, id: string, status: GoalStatus): GoalRecord {
	return {
		id,
		status,
		request: requireString(raw, "request"),
		clarifiedGoal: requireString(raw, "clarifiedGoal"),
		criteria: requireArray<AcceptanceCriterion>(raw, "criteria"),
		verification: requireArray<VerificationResult>(raw, "verification"),
		iterations: requireNumber(raw, "iterations"),
		windowIterations: requireNumber(raw, "windowIterations"),
		resets: requireNumber(raw, "resets"),
		generation: requireNumber(raw, "generation"),
		lastCheckpoint: requireString(raw, "lastCheckpoint"),
		nextAction: requireString(raw, "nextAction"),
		config: requireConfig(raw),
		worktree: requireStringOrNull(raw, "worktree"),
		branch: requireStringOrNull(raw, "branch"),
		pr: requirePr(raw),
		blocker: requireStringOrNull(raw, "blocker"),
		steering: requireStringArray(raw, "steering"),
		compactionSeen: requireBoolean(raw, "compactionSeen"),
		inFlight: requireBoolean(raw, "inFlight"),
	};
}

function requireString(raw: RawFields, key: string): string {
	const value = raw.get(key);
	if (typeof value !== "string") throw new Error(`key "${key}" must be a string`);
	return value;
}

function requireStringOrNull(raw: RawFields, key: string): string | null {
	const value = raw.get(key);
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`key "${key}" must be a string or null`);
	return value;
}

function requireNumber(raw: RawFields, key: string): number {
	const value = raw.get(key);
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`key "${key}" must be a number`);
	}
	return value;
}

function requireBoolean(raw: RawFields, key: string): boolean {
	const value = raw.get(key);
	if (typeof value !== "boolean") throw new Error(`key "${key}" must be a boolean`);
	return value;
}

function requireArray<T>(raw: RawFields, key: string): T[] {
	const value = raw.get(key);
	if (!Array.isArray(value)) throw new Error(`key "${key}" must be an array`);
	return value as T[];
}

function requireStringArray(raw: RawFields, key: string): string[] {
	const value = requireArray<unknown>(raw, key);
	for (const entry of value) {
		if (typeof entry !== "string") throw new Error(`key "${key}" must be an array of strings`);
	}
	return value as string[];
}

function requireConfig(raw: RawFields): GoalConfigSnapshot {
	const value = raw.get("config");
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error('key "config" must be an object');
	}
	const cfg = value as Record<string, unknown>;
	if (typeof cfg.model !== "string") throw new Error('key "config.model" must be a string');
	if (typeof cfg.rolloverTokens !== "number") {
		throw new Error('key "config.rolloverTokens" must be a number');
	}
	if (typeof cfg.maxIterations !== "number") {
		throw new Error('key "config.maxIterations" must be a number');
	}
	return {
		model: cfg.model,
		rolloverTokens: cfg.rolloverTokens,
		maxIterations: cfg.maxIterations,
	};
}

function requirePr(raw: RawFields): GoalPullRequest | null {
	const value = raw.get("pr");
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error('key "pr" must be an object or null');
	}
	const pr = value as Record<string, unknown>;
	if (typeof pr.number !== "number") throw new Error('key "pr.number" must be a number');
	if (typeof pr.nodeId !== "string") throw new Error('key "pr.nodeId" must be a string');
	if (typeof pr.state !== "string") throw new Error('key "pr.state" must be a string');
	return {
		number: pr.number,
		nodeId: pr.nodeId,
		state: pr.state as GoalPullRequest["state"],
	};
}
