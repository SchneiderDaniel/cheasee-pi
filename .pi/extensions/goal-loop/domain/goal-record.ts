// ─── Goal record entity ───────────────────────────────────────────
// The durable, session-independent goal state (R2). Pure: no pi, git, gh or
// fs imports — serialization is a string transform so the adapter owns I/O and
// the domain owns shape.
//
// The record lives as Markdown with YAML front matter. Every front-matter
// value is a JSON scalar or a single-line JSON flow collection: JSON is a
// strict subset of YAML 1.2 flow syntax, so the file stays valid YAML while the
// parser needs no YAML dependency and can fail closed on the first malformed
// line. Structured values (criteria, verification, config, pr) are therefore
// *never* multi-line, which removes the whole class of "the model reflowed the
// file" corruption the Researcher flagged.
//
// The loop owns the front matter AND the managed body section; the agent's own
// prose is confined to the marker-delimited agent section.

import { failure, type Result } from "../../shared/result.ts";

// ─── Statuses ────────────────────────────────────────────────────

/** Every goal status. `complete` and `cancelled` are terminal. */
export const GOAL_STATUSES = [
	"clarifying",
	"active",
	"verifying",
	"paused",
	"complete",
	"cancelled",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * Statuses that block a second `/goal` in the same checkout. Terminal records
 * (`complete`, `cancelled`) are retained on disk but never block a new goal.
 */
export const ACTIVE_STATUSES: readonly GoalStatus[] = [
	"clarifying",
	"active",
	"verifying",
	"paused",
];

/** Terminal statuses: no transition out of them is legal. */
export const TERMINAL_STATUSES: readonly GoalStatus[] = ["complete", "cancelled"];

/**
 * The complete transition table. Anything absent is rejected.
 *
 * `→ clarifying` is reachable from every non-terminal status: `/goal revise`
 * explicitly re-opens the goal for clarification (R4.AC4). `→ cancelled` is
 * reachable from every non-terminal status: `/goal stop` is always available.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
	clarifying: ["active", "cancelled"],
	active: ["verifying", "paused", "cancelled", "clarifying"],
	verifying: ["active", "complete", "clarifying", "cancelled"],
	paused: ["active", "clarifying", "cancelled"],
	complete: [],
	cancelled: [],
};

/** True when `status` blocks a new goal (non-terminal). */
export function isActiveStatus(status: GoalStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

// ─── Verification model ──────────────────────────────────────────

/** A pinned file the harness hashes before running a command verifier. */
export interface PinnedFile {
	path: string;
	sha256: string;
}

/**
 * How one acceptance criterion is checked.
 *
 * - `command`: the harness runs `argv` in the worktree (never through a shell)
 *   after verifying every pinned hash. Agent-authored checks are gated by the
 *   pins; the harness — not the model — decides pass/fail from the exit code.
 * - `inspect`: no executable form exists, so a nested fresh-context call judges
 *   harness-produced evidence only. Never satisfied by a prior record claim.
 */
export type Verifier =
	| { kind: "command"; argv: string[]; pinned: PinnedFile[]; expectExit: number }
	| { kind: "inspect"; instruction: string };

/** One acceptance criterion with its verification method (R1, R4). */
export interface AcceptanceCriterion {
	id: string;
	text: string;
	verifier: Verifier;
}

/** Result of one verification pass for one criterion. */
export interface VerificationResult {
	criterionId: string;
	result: "pass" | "fail";
	/** Where the evidence came from (command line, evidence file, diff ref). */
	evidenceRef: string;
	/** ISO timestamp of the check. */
	checkedAt: string;
}

// ─── Configuration snapshot ──────────────────────────────────────

/** Effective goal-loop configuration snapshotted into the record. */
export interface GoalConfigSnapshot {
	/** `provider/model-id` used for clarification, implementation and verification. */
	model: string;
	/** Context-usage threshold that triggers a fresh-session rollover. */
	rolloverTokens: number;
	/** Maximum completed work iterations before the loop pauses for approval. */
	maxIterations: number;
}

// ─── Record ──────────────────────────────────────────────────────

/** Pull-request reference. `nodeId` is required to un-draft via GraphQL. */
export interface GoalPullRequest {
	number: number;
	nodeId: string;
	state: "draft" | "open" | "merged" | "closed";
}

/** The complete durable goal record (R2.AC2). */
export interface GoalRecord {
	id: string;
	status: GoalStatus;
	/** The literal `/goal` argument. */
	request: string;
	/** Restated, measured goal produced by clarification. */
	clarifiedGoal: string;
	criteria: AcceptanceCriterion[];
	verification: VerificationResult[];
	/** Completed work iterations, cumulative across sessions. */
	iterations: number;
	/** Iterations completed in the current context generation. */
	windowIterations: number;
	/** Context resets performed, cumulative. */
	resets: number;
	/** Current context generation index (0 = first session). */
	generation: number;
	/** ISO timestamp of the last successful record write. */
	lastCheckpoint: string;
	/** The single next action a fresh session resumes from. */
	nextAction: string;
	config: GoalConfigSnapshot;
	worktree: string | null;
	branch: string | null;
	pr: GoalPullRequest | null;
	blocker: string | null;
	steering: string[];
	/** An in-place compaction was observed; the next boundary rolls over. */
	compactionSeen: boolean;
	/** An iteration is running (used to fail closed on a crashed session). */
	inFlight: boolean;
}

// ─── Creation ────────────────────────────────────────────────────

/** Marker delimiting the loop-owned body section (regenerated on every write). */
export const MANAGED_SECTION_MARKER = "<!-- loop:managed -->";
export const AGENT_SECTION_BEGIN = "<!-- agent:begin -->";
export const AGENT_SECTION_END = "<!-- agent:end -->";

/** Longest slug retained in a record id. */
const MAX_SLUG_LENGTH = 50;

/** Base36 space for the 4-character id suffix. */
const ID_SUFFIX_SPACE = 1_679_616;

const SEED = Math.floor(Math.random() * ID_SUFFIX_SPACE);
let suffixSequence = 0;

/**
 * A 4-character suffix. Seeded per process and advanced per call, so two
 * records created in the same second (or the same millisecond) always differ.
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

/**
 * Reject an id that could escape the record directory or escape it through a
 * traversal segment. Called before any path is built.
 */
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

// ─── Transitions ─────────────────────────────────────────────────

/** True when `from → to` is in the transition table (or a no-op). */
export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
	if (from === to) return true;
	return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Assert a legal status transition.
 *
 * Terminal statuses reject every transition and the thrown message names both
 * statuses, so a caller's error report is actionable.
 */
export function assertTransition(from: GoalStatus, to: GoalStatus): void {
	if (TERMINAL_STATUSES.includes(from) && from !== to) {
		throw new Error(`illegal goal status transition ${from} → ${to}: ${from} is terminal`);
	}
	if (from !== to && !ALLOWED_TRANSITIONS[from].includes(to)) {
		throw new Error(`illegal goal status transition ${from} → ${to}`);
	}
}

/** Move `record` to `status`, throwing when the transition is illegal. */
export function transitionTo(record: GoalRecord, status: GoalStatus): GoalRecord {
	assertTransition(record.status, status);
	return { ...record, status };
}

// ─── Serialization ───────────────────────────────────────────────

/** Front-matter keys in write order — also the parser's required-key list. */
const FRONT_MATTER_KEYS = [
	"id",
	"status",
	"request",
	"clarifiedGoal",
	"criteria",
	"verification",
	"iterations",
	"windowIterations",
	"resets",
	"generation",
	"lastCheckpoint",
	"nextAction",
	"config",
	"worktree",
	"branch",
	"pr",
	"blocker",
	"steering",
	"compactionSeen",
	"inFlight",
] as const;

type FrontMatterKey = (typeof FRONT_MATTER_KEYS)[number];

function frontMatterValue(record: GoalRecord, key: FrontMatterKey): unknown {
	return record[key];
}

/**
 * Render the record as Markdown.
 *
 * The managed section is regenerated from the record on every call (so hand
 * edits to it are overwritten by design); `agentSection` is the only text the
 * agent owns and is carried through verbatim.
 */
export function serializeGoalRecord(record: GoalRecord, agentSection = ""): string {
	const lines: string[] = ["---"];
	for (const key of FRONT_MATTER_KEYS) {
		lines.push(`${key}: ${JSON.stringify(frontMatterValue(record, key))}`);
	}
	lines.push("---", "");
	lines.push(`# Goal ${record.id}`, "");
	lines.push(MANAGED_SECTION_MARKER);
	lines.push(...renderManagedBody(record));
	lines.push("");
	lines.push(AGENT_SECTION_BEGIN);
	const trimmed = agentSection.trim();
	lines.push(trimmed === "" ? "<!-- no agent notes -->" : trimmed);
	lines.push(AGENT_SECTION_END, "");
	return lines.join("\n");
}

/** The loop-owned body: one line per machine-read field, plus tables. */
function renderManagedBody(record: GoalRecord): string[] {
	const out: string[] = [
		`- status: ${record.status}`,
		`- iterations: ${record.iterations}`,
		`- windowIterations: ${record.windowIterations}`,
		`- resets: ${record.resets}`,
		`- generation: ${record.generation}`,
		`- lastCheckpoint: ${record.lastCheckpoint}`,
		`- nextAction: ${record.nextAction || "(none)"}`,
		`- worktree: ${record.worktree ?? "(none)"}`,
		`- branch: ${record.branch ?? "(none)"}`,
		`- pr: ${record.pr ? `#${record.pr.number} (${record.pr.state})` : "(none)"}`,
		`- blocker: ${record.blocker ?? "(none)"}`,
		`- model: ${record.config.model}`,
		`- rolloverTokens: ${record.config.rolloverTokens}`,
		`- maxIterations: ${record.config.maxIterations}`,
		"",
		"## Acceptance criteria",
		"",
	];
	if (record.criteria.length === 0) {
		out.push("(none yet)");
	} else {
		out.push("| id | criterion | verifier |", "| --- | --- | --- |");
		for (const c of record.criteria) {
			const verifier =
				c.verifier.kind === "command"
					? `command \`${c.verifier.argv.join(" ")}\` (exit ${c.verifier.expectExit})`
					: "inspect";
			out.push(`| ${c.id} | ${c.text} | ${verifier} |`);
		}
	}
	out.push("", "## Verification evidence", "");
	if (record.verification.length === 0) {
		out.push("(none yet)");
	} else {
		out.push("| criterion | result | evidence | checkedAt |", "| --- | --- | --- | --- |");
		for (const v of record.verification) {
			out.push(`| ${v.criterionId} | ${v.result} | ${v.evidenceRef} | ${v.checkedAt} |`);
		}
	}
	out.push("", "## Steering", "");
	if (record.steering.length === 0) {
		out.push("(none)");
	} else {
		for (const s of record.steering) out.push(`- ${s}`);
	}
	return out;
}

// ─── Parsing ─────────────────────────────────────────────────────

/** Split a record document into its front-matter lines and the body. */
function splitFrontMatter(text: string): Result<{ lines: string[]; body: string }> {
	const normalised = text.replace(/\r\n/g, "\n");
	if (!normalised.startsWith("---\n")) {
		return failure("missing front matter (file must start with '---')", "goal-record");
	}
	const end = normalised.indexOf("\n---", 3);
	if (end < 0) {
		return failure("truncated front matter (no closing '---')", "goal-record");
	}
	const lines = normalised.slice(4, end).split("\n");
	const body = normalised.slice(end + 4);
	return { ok: true, value: { lines, body } };
}

const STATUS_SET = new Set<string>(GOAL_STATUSES);

/**
 * Parse a record document. Fail-closed: a truncated front matter, a missing
 * required key, a value that is not valid JSON, or an unknown `status` each
 * return an error — nothing is defaulted or coerced.
 */
export function parseGoalRecord(text: string): Result<GoalRecord> {
	const split = splitFrontMatter(text);
	if (!split.ok) return split;

	const raw = new Map<string, unknown>();
	for (const line of split.value.lines) {
		if (line.trim() === "") continue;
		const match = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
		if (!match) {
			return failure(`malformed front-matter line: "${line.slice(0, 60)}"`, "goal-record");
		}
		const [, key, value] = match as unknown as [string, string, string];
		try {
			raw.set(key, JSON.parse(value));
		} catch {
			return failure(`front-matter key "${key}" is not valid JSON`, "goal-record");
		}
	}

	for (const key of FRONT_MATTER_KEYS) {
		if (!raw.has(key)) {
			return failure(`missing required front-matter key "${key}"`, "goal-record");
		}
	}

	const status = raw.get("status");
	if (typeof status !== "string" || !STATUS_SET.has(status)) {
		return failure(`unknown goal status "${String(status)}"`, "goal-record");
	}

	const id = raw.get("id");
	if (typeof id !== "string")
		return failure('front-matter key "id" must be a string', "goal-record");
	try {
		assertSafeGoalId(id);
	} catch (err: unknown) {
		return failure(err instanceof Error ? err.message : String(err), "goal-record");
	}

	const record = buildRecord(raw, id, status as GoalStatus);
	if (!record.ok) return record;
	return { ok: true, value: record.value };
}

/**
 * Assemble the typed record, converting any shape violation into a failure
 * that names the offending key. Kept in one place so `parseGoalRecord` has a
 * single try/catch instead of one per field.
 */
function buildRecord(
	raw: Map<string, unknown>,
	id: string,
	status: GoalStatus,
): Result<GoalRecord> {
	try {
		return {
			ok: true,
			value: {
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
			},
		};
	} catch (err: unknown) {
		return failure(err instanceof Error ? err.message : String(err), "goal-record");
	}
}

function requireString(raw: Map<string, unknown>, key: string): string {
	const value = raw.get(key);
	if (typeof value !== "string") throw new Error(`key "${key}" must be a string`);
	return value;
}

function requireStringOrNull(raw: Map<string, unknown>, key: string): string | null {
	const value = raw.get(key);
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`key "${key}" must be a string or null`);
	return value;
}

function requireNumber(raw: Map<string, unknown>, key: string): number {
	const value = raw.get(key);
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`key "${key}" must be a number`);
	}
	return value;
}

function requireBoolean(raw: Map<string, unknown>, key: string): boolean {
	const value = raw.get(key);
	if (typeof value !== "boolean") throw new Error(`key "${key}" must be a boolean`);
	return value;
}

function requireArray<T>(raw: Map<string, unknown>, key: string): T[] {
	const value = raw.get(key);
	if (!Array.isArray(value)) throw new Error(`key "${key}" must be an array`);
	return value as T[];
}

function requireStringArray(raw: Map<string, unknown>, key: string): string[] {
	const value = requireArray<unknown>(raw, key);
	for (const entry of value) {
		if (typeof entry !== "string") throw new Error(`key "${key}" must be an array of strings`);
	}
	return value as string[];
}

function requireConfig(raw: Map<string, unknown>): GoalConfigSnapshot {
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

function requirePr(raw: Map<string, unknown>): GoalPullRequest | null {
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

// ─── Agent section ───────────────────────────────────────────────

/** The agent-owned body text, or `""` when the markers are absent. */
export function extractAgentSection(text: string): string {
	const start = text.indexOf(AGENT_SECTION_BEGIN);
	const end = text.indexOf(AGENT_SECTION_END);
	if (start < 0 || end < 0 || end < start) return "";
	return text
		.slice(start + AGENT_SECTION_BEGIN.length, end)
		.replace(/^<!-- no agent notes -->\s*$/, "")
		.trim();
}

// ─── Convenience ─────────────────────────────────────────────────

/** The single non-terminal record, or a failure naming every conflict. */
export function findActiveRecord(records: GoalRecord[]): Result<GoalRecord | null> {
	const active = records.filter((r) => isActiveStatus(r.status));
	if (active.length === 0) return { ok: true, value: null };
	if (active.length > 1) {
		return failure(
			`multiple active goals found: ${active.map((r) => r.id).join(", ")}`,
			"goal-record",
		);
	}
	return { ok: true, value: active[0]! };
}
