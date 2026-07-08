// ─── Dependency Gate ─────────────────────────────────────────────
// checkBlockedByDependencies — queries GitHub timeline to detect
// "blocked by" links for a given issue.

import type { ExecFn } from "../pipeline/helpers.ts";
import type { DepsResult, GhTimelineResponse } from "../config/types.ts";
import { ghGraphQL } from "./gh-client.ts";
import { getDebugLogger } from "../lib/debug.ts";

// ─── Parse Timeline Response ─────────────────────────────────────

function parseTimelineResponse(response: GhTimelineResponse | null): DepsResult {
	if (response?.errors && response.errors.length > 0) {
		const msgs = response.errors.map((e) => e.message).join("; ");
		throw new Error(`GitHub GraphQL error: ${msgs}`);
	}

	const nodes = response?.data?.repository?.issue?.timelineItems?.nodes;
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

// ─── Check Blocked By Dependencies ────────────────────────────────

export async function checkBlockedByDependencies(
	exec: ExecFn,
	issueNumber: number,
	repo: string,
): Promise<DepsResult> {
	const log = getDebugLogger();
	log.info("deps", `Checking deps for #${issueNumber} on ${repo}`);
	const [owner, name] = repo.split("/");
	if (!owner || !name) {
		const errMsg = `Invalid repo format: ${repo} (expected owner/name)`;
		log.error("deps", errMsg);
		throw new Error(errMsg);
	}

	const query = `
    query {
      repository(owner: "${owner}", name: "${name}") {
        issue(number: ${issueNumber}) {
          timelineItems(itemTypes: [BLOCKED_BY_ADDED_EVENT, BLOCKED_BY_REMOVED_EVENT], first: 100) {
            nodes {
              __typename
              ... on BlockedByAddedEvent {
                blockingIssue {
                  id
                  number
                  title
                  state
                }
              }
              ... on BlockedByRemovedEvent {
                blockingIssue {
                  id
                  number
                  title
                  state
                }
              }
            }
          }
        }
      }
    }`;

	let response: GhTimelineResponse | null;
	try {
		response = await ghGraphQL<GhTimelineResponse>(exec, query);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error("deps", `Dependency query failed: ${msg}`);
		throw new Error(`Failed to query GitHub for dependencies: ${msg}`);
	}

	const result = parseTimelineResponse(response);
	log.info(
		"deps",
		`Deps check result: blocked=${result.blocked}, blockers=${result.blockers.length}`,
	);
	if (result.blockers.length > 0) {
		log.info("deps", "Blockers", {
			blockers: result.blockers.map((b) => `#${b.number}: ${b.title.slice(0, 60)}`),
		});
	}
	return result;
}
