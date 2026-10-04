/**
 * nested.ts — Nested tool-call semantics for session-logger.
 *
 * Deep module owning every rule about calls a tool made to other tools:
 *   - attribution: recover the parent id from the `<parent>/<n>` id scheme
 *   - rollup: fold a bounded `NestedToolCalls` record into counts
 *   - completeness: classify why a record is `complete: false`
 *
 * Runtime note: the `tool_execution_start/update/end` extension events do NOT
 * carry `parentToolCallId` (the host rebuilds the payload field-by-field and
 * omits it), so attribution is derived from the id suffix, never the event.
 *
 * The `NestedToolCalls` / `NestedToolCallRecord` shapes mirror the host's
 * published types. They are declared locally because the installed
 * `@earendil-works/pi-ai` version predates them; the field names are kept
 * identical so a host upgrade stays structurally compatible.
 */

// ── Types ──

/** A tool call that another tool made while it ran (e.g. from a codemode script). */
interface NestedToolCallRecord {
	id: string;
	name: string;
	/** Omitted when over the size limits; `argumentsBytes` then gives their size. */
	arguments?: unknown;
	/** UTF-8 size of the arguments as JSON, set when `arguments` is omitted. */
	argumentsBytes?: number;
	/** `unfinished`: the call was still running when the calling tool finished. */
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	/** Error text, truncated. */
	error?: string;
}

/** Bounded record of the nested calls a tool made. */
export interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	/** False when calls were dropped, arguments omitted, or calls had not finished. */
	complete: boolean;
}

/** Why a `NestedToolCalls` record is incomplete. */
export type IncompleteReason = "dropped" | "arguments-omitted" | "unfinished";

/** Per-parent rollup of nested activity. `incomplete` is absent when complete. */
export interface NestedCallAnnotation {
	nestedCalls: number;
	nestedErrors: number;
	nestedDurationMs: number;
	incomplete?: IncompleteReason;
}

// ── Attribution ──

/**
 * Recover the parent tool-call id from a nested id.
 *
 * pi assigns nested calls `<parent id>/<n>` with a per-parent 1-based counter,
 * recursively, so `codemode_1/1/1` belongs to `codemode_1/1`. Top-level ids
 * carry no slash and return undefined.
 */
export function deriveParentToolCallId(toolCallId: string): string | undefined {
	if (!toolCallId) return undefined;
	const slash = toolCallId.lastIndexOf("/");
	if (slash <= 0) return undefined;
	return toolCallId.slice(0, slash);
}

// ── Rollup ──

/** Fold a nested-call record into call/error/duration counts. */
export function rollupNestedCalls(record: NestedToolCalls): {
	nestedCalls: number;
	nestedErrors: number;
	nestedDurationMs: number;
} {
	let nestedCalls = 0;
	let nestedErrors = 0;
	let nestedDurationMs = 0;
	for (const call of record?.calls ?? []) {
		nestedCalls++;
		if (call.status === "error") nestedErrors++;
		if (typeof call.durationMs === "number") nestedDurationMs += call.durationMs;
	}
	return { nestedCalls, nestedErrors, nestedDurationMs };
}

// ── Completeness ──

/**
 * Classify why a record is incomplete. `complete: false` has three causes and
 * only one is real data loss, so a generic "truncated" flag would false-alarm
 * on routine arguments-omitted (>8 KiB/32 KiB) and unfinished calls.
 */
export function classifyIncomplete(record: NestedToolCalls): IncompleteReason | undefined {
	if (record?.complete) return undefined;
	const calls = record?.calls ?? [];
	if (calls.some((c) => c.status === "unfinished")) return "unfinished";
	if (calls.some((c) => c.arguments === undefined && c.argumentsBytes !== undefined)) {
		return "arguments-omitted";
	}
	return "dropped";
}

/**
 * Build the per-parent annotation for one toolResult message, or undefined when
 * the message carries no `nestedCalls` record. Keeps the `incomplete` key absent
 * (not `undefined`) so non-nested metadata stays byte-identical.
 */
export function annotateNested(record: NestedToolCalls | undefined): NestedCallAnnotation | undefined {
	if (!record) return undefined;
	const { nestedCalls, nestedErrors, nestedDurationMs } = rollupNestedCalls(record);
	const incomplete = classifyIncomplete(record);
	const annotation: NestedCallAnnotation = { nestedCalls, nestedErrors, nestedDurationMs };
	if (incomplete) annotation.incomplete = incomplete;
	return annotation;
}

/** Severity order for merging `incomplete` reasons; higher wins. `dropped` is real data loss. */
const INCOMPLETE_SEVERITY: Record<IncompleteReason, number> = {
	"arguments-omitted": 0,
	unfinished: 1,
	dropped: 2,
};

/**
 * Fold a new annotation for the same parent into the accumulated one.
 *
 * A parent tool can have several toolResult messages (one per invocation), each
 * with its own `nestedCalls`. Counts sum; the `incomplete` flag is kept at the
 * most severe reason seen so an earlier flag is never lost to a later result.
 */
export function mergeNestedAnnotation(
	accumulated: NestedCallAnnotation | undefined,
	next: NestedCallAnnotation,
): NestedCallAnnotation {
	if (!accumulated) return next;
	const merged: NestedCallAnnotation = {
		nestedCalls: accumulated.nestedCalls + next.nestedCalls,
		nestedErrors: accumulated.nestedErrors + next.nestedErrors,
		nestedDurationMs: accumulated.nestedDurationMs + next.nestedDurationMs,
	};
	const reasons = [accumulated.incomplete, next.incomplete].filter(
		(r): r is IncompleteReason => r !== undefined,
	);
	if (reasons.length > 0) {
		merged.incomplete = reasons.reduce((a, b) =>
			INCOMPLETE_SEVERITY[a] >= INCOMPLETE_SEVERITY[b] ? a : b,
		);
	}
	return merged;
}
