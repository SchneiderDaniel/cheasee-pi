// ─── GitHub GraphQL Parsers ───────────────────────────────────────
// Pure domain parsers for GitHub GraphQL response nodes.
// No I/O, no error throwing — operate on extracted node arrays only.

import type {
	DepsResult,
	GhTimelineNode,
	PrConflictInfo,
	ProjectFieldValueNode,
} from "../config/types.ts";

// ─── Parse Dependency Timeline ────────────────────────────────────

export function parseDepsTimeline(nodes: GhTimelineNode[] | null | undefined): DepsResult {
	if (!nodes || nodes.length === 0) {
		return { blocked: false, blockers: [] };
	}

	const lastEventByIssue = new Map<string, string>();

	for (const node of nodes) {
		const blockingId = node?.blockingIssue?.id;
		if (!blockingId) continue;
		lastEventByIssue.set(blockingId, node.__typename);
	}

	const blockers: DepsResult["blockers"] = [];
	const seenNumbers = new Set<number>();

	for (const node of nodes) {
		const issue = node.blockingIssue;
		if (!issue) continue;
		const lastEvent = lastEventByIssue.get(issue.id);
		if (lastEvent !== "BlockedByAddedEvent") continue;
		if (seenNumbers.has(issue.number)) continue;
		seenNumbers.add(issue.number);
		const state = issue.state || "UNKNOWN";
		if (state === "CLOSED") continue;
		blockers.push({
			number: issue.number,
			title: issue.title || "",
			type: "issue",
			state,
		});
	}

	return {
		blocked: blockers.length > 0,
		blockers,
	};
}

// ─── Extract Project Item Fields ──────────────────────────────────

export function extractProjectItemFields(
	fieldValueNodes: ProjectFieldValueNode[] | null | undefined,
): { status?: string; fieldValues?: Array<{ fieldId: string; value: string; optionId?: string }> } {
	if (!fieldValueNodes || fieldValueNodes.length === 0) {
		return { status: undefined, fieldValues: undefined };
	}

	let status: string | undefined;
	const fv: Array<{ fieldId: string; value: string; optionId?: string }> = [];

	for (const f of fieldValueNodes) {
		if (f.name && f.field?.name?.toLowerCase() === "status") {
			status = f.name;
		}
		if (f.field?.id) {
			fv.push({
				fieldId: f.field.id,
				value: f.name || f.text || "",
				optionId: undefined,
			});
		}
	}

	return {
		status,
		fieldValues: fv.length > 0 ? fv : undefined,
	};
}

// ─── REST → Domain PR Conflict Mapping ──────────────────────────
// Pure translation of a REST `pulls.list` item into the domain
// PrConflictInfo shape. REST fields (issue #1472):
//   - mergeable: boolean | null  (null = background computation in progress)
//   - mergeable_state: "clean|dirty|unknown|blocked|unstable|behind|has_hooks|draft"
// Only `dirty` counts as a conflict; the other non-clean states mean the PR
// exists and is mergeable (blocked/unstable/behind/has_hooks/draft) or is
// still being computed (unknown) — the gate polls UNKNOWN instead of failing.

export function mapRestPrToConflictInfo(
	pr: Record<string, unknown>,
	fallbackHeadRef: string,
	fallbackBaseRef: string,
): PrConflictInfo {
	const mergeableRaw = pr.mergeable as boolean | null | undefined;
	const mergeable =
		mergeableRaw === null || mergeableRaw === undefined
			? "UNKNOWN"
			: mergeableRaw
				? "MERGEABLE"
				: "NOT_MERGEABLE";
	const mergeableState = (pr.mergeable_state as string | undefined) || "unknown";
	return {
		number: pr.number as number,
		hasConflict: mergeableState.toLowerCase() === "dirty",
		mergeable,
		mergeStateStatus: mergeableState.toUpperCase(),
		headRefName: (pr.head as { ref?: string })?.ref || fallbackHeadRef,
		baseRefName: (pr.base as { ref?: string })?.ref || fallbackBaseRef,
	};
}

// Octokit throws RequestError ({ status: 404 }) for a missing issue or a
// missing sub-resource. Adapter-local: this shape knowledge never leaves the
// GitHub client. Duck-typed because @octokit/request-error is a transitive dep.
export function isNotFound(err: unknown): boolean {
	return err instanceof Object && "status" in err && (err as { status: number }).status === 404;
}
