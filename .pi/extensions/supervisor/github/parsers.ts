// ─── GitHub GraphQL Parsers ───────────────────────────────────────
// Pure domain parsers for GitHub GraphQL response nodes.
// No I/O, no error throwing — operate on extracted node arrays only.

import type {
	DepsResult,
	GhTimelineNode,
	PrConflictInfo,
	ProjectFieldValueNode,
	ProjectItem,
} from "../config/types.ts";
import type { ClosingPrRef } from "./ports.ts";

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

// ─── Project Items Page → Domain Mapping (issue #2098) ──────────
// One GraphQL `items` page into domain items plus the cursor state the
// pagination loop needs. Pure: no I/O, no network, no adapter state.

interface ProjectItemsPageNode {
	id: string;
	content?: { url?: string; number?: number } | null;
	fieldValues?: { nodes?: ProjectFieldValueNode[] | null } | null;
}

export interface ProjectItemsPage {
	pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
	nodes?: ProjectItemsPageNode[] | null;
}

export interface ProjectItemsPageResult {
	items: ProjectItem[];
	hasNextPage: boolean;
	endCursor: string | null;
}

export function mapProjectItemsPage(
	page: ProjectItemsPage | null | undefined,
): ProjectItemsPageResult {
	const items: ProjectItem[] = [];

	for (const node of page?.nodes || []) {
		const { status, fieldValues } = extractProjectItemFields(node.fieldValues?.nodes);
		items.push({
			id: node.id,
			status,
			content: node.content ? { url: node.content.url, number: node.content.number } : undefined,
			fieldValues,
		});
	}

	return {
		items,
		hasNextPage: page?.pageInfo?.hasNextPage ?? false,
		endCursor: page?.pageInfo?.endCursor ?? null,
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

// ─── PR Detail → Closing PR Ref Mapping ────────────────────────
// Pure translation of a REST `pulls.get` item into the domain ClosingPrRef
// shape (issue #2102). Octokit response names stay in this adapter layer, so
// the merged/closed/open derivation and the closing-keyword rule are
// unit-testable without HTTP mocks.

const CLOSING_KEYWORDS = "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved";

export function mapPrToClosingRef(pr: Record<string, unknown>, issueNum: number): ClosingPrRef {
	const head = pr.head as { sha?: string; ref?: string } | undefined;
	const body = (pr.body as string | undefined) || "";
	const closingPattern = new RegExp(`(${CLOSING_KEYWORDS})\\s*#${issueNum}\\b`, "i");
	return {
		number: pr.number as number,
		sha: (pr.merge_commit_sha as string | null | undefined) || head?.sha || "",
		source: closingPattern.test(body) ? "closing-keyword" : "branch-head",
		branch: head?.ref || "",
		state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
	};
}

// Octokit throws RequestError ({ status: 404 }) for a missing issue or a
// missing sub-resource. Adapter-local: this shape knowledge never leaves the
// GitHub client. Duck-typed because @octokit/request-error is a transitive dep.
export function isNotFound(err: unknown): boolean {
	return err instanceof Object && "status" in err && (err as { status: number }).status === 404;
}
