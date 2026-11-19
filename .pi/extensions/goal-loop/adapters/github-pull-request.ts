// ─── GitHub pull-request adapter ─────────────────────────────────
// Adapter for {@link PullRequestPort}. Create and body updates go through REST;
// un-drafting goes through GraphQL.
//
// Why GraphQL for un-draft: `PATCH /repos/{owner}/{repo}/pulls/{n}` silently
// ignores `draft: false` and still returns success, so a REST-based R3.AC4 would
// report "marked ready for review" while the PR stays a draft forever. The
// GraphQL `markPullRequestReadyForReview` mutation is the only working path.
//
// There is no merge and no close operation here on purpose: the goal loop hands
// the PR to the user.

import { failure, type Result } from "../../shared/result.ts";
import type { GoalPullRequest } from "../domain/goal-record.ts";
import type { OpenDraftInput, PullRequestPort } from "../application/ports.ts";

const SOURCE = "goal-pr";

/** REST payloads this adapter needs from `@octokit/rest`. */
export interface PullsRestClient {
	pulls: {
		create(params: {
			owner: string;
			repo: string;
			title: string;
			head: string;
			base: string;
			body: string;
			draft: boolean;
		}): Promise<{ data: { number: number; node_id?: string } }>;
		update(params: {
			owner: string;
			repo: string;
			pull_number: number;
			body: string;
		}): Promise<{ data: unknown }>;
		get(params: { owner: string; repo: string; pull_number: number }): Promise<{
			data: { number: number; state: string; draft?: boolean | null; merged_at?: string | null };
		}>;
	};
}

/** GraphQL call shape this adapter needs from `@octokit/graphql`. */
export interface GraphqlClient {
	(
		query: string,
		variables: Record<string, unknown>,
	): Promise<{
		markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } };
	}>;
}

/** The Octokit surface this adapter uses. */
export interface OctokitLike {
	rest: PullsRestClient;
	graphql: GraphqlClient;
}

/** Mutation that un-drafts a PR; REST cannot do this. */
export const MARK_READY_FOR_REVIEW_MUTATION = `mutation MarkReadyForReview($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest {
      isDraft
    }
  }
}`;

/** Split `owner/repo`; a malformed value fails closed. */
function splitRepo(repo: string): Result<{ owner: string; name: string }> {
	const parts = repo.split("/");
	if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
		return failure(`invalid repository "${repo}" — expected "owner/repo"`, SOURCE);
	}
	return { ok: true, value: { owner: parts[0]!, name: parts[1]! } };
}

/**
 * Octokit-backed {@link PullRequestPort}.
 *
 * `client` is injected so tests exercise the exact REST/GraphQL calls with a
 * recording fake and never touch the network.
 */
export class GitHubPullRequestAdapter implements PullRequestPort {
	private readonly client: OctokitLike;
	private readonly repo: string;

	constructor(client: OctokitLike, repo: string) {
		this.client = client;
		this.repo = repo;
	}

	/** Open a draft PR and capture the node id needed later to un-draft it. */
	async openDraft(input: OpenDraftInput): Promise<Result<{ number: number; nodeId: string }>> {
		const split = splitRepo(this.repo);
		if (!split.ok) return split;
		try {
			const response = await this.client.rest.pulls.create({
				owner: split.value.owner,
				repo: split.value.name,
				title: input.title,
				head: input.branch,
				base: input.base,
				body: input.body,
				draft: true,
			});
			const nodeId = response.data.node_id;
			if (!nodeId) {
				return failure(
					`PR #${response.data.number} was created without a node id — cannot mark it ready for review`,
					SOURCE,
				);
			}
			return { ok: true, value: { number: response.data.number, nodeId } };
		} catch (err: unknown) {
			return failure(
				`cannot open a draft pull request: ${err instanceof Error ? err.message : String(err)}`,
				SOURCE,
			);
		}
	}

	/** Replace the PR body as work progresses. */
	async updateBody(input: { number: number; body: string }): Promise<Result<void>> {
		const split = splitRepo(this.repo);
		if (!split.ok) return split;
		try {
			await this.client.rest.pulls.update({
				owner: split.value.owner,
				repo: split.value.name,
				pull_number: input.number,
				body: input.body,
			});
			return { ok: true, value: undefined };
		} catch (err: unknown) {
			return failure(
				`cannot update pull request #${input.number}: ${
					err instanceof Error ? err.message : String(err)
				}`,
				SOURCE,
			);
		}
	}

	/**
	 * Mark the PR ready for review via GraphQL. Never reports success without a
	 * successful mutation response.
	 */
	async markReadyForReview(nodeId: string): Promise<Result<void>> {
		try {
			const response = await this.client.graphql(MARK_READY_FOR_REVIEW_MUTATION, {
				pullRequestId: nodeId,
			});
			if (!response?.markPullRequestReadyForReview?.pullRequest) {
				return failure(
					`markPullRequestReadyForReview returned no pull request for node ${nodeId}`,
					SOURCE,
				);
			}
			return { ok: true, value: undefined };
		} catch (err: unknown) {
			return failure(
				`cannot mark pull request ${nodeId} ready for review: ${
					err instanceof Error ? err.message : String(err)
				}`,
				SOURCE,
			);
		}
	}

	/** Current PR state, mapped onto the goal record's vocabulary. */
	async getState(number: number): Promise<Result<GoalPullRequest["state"]>> {
		const split = splitRepo(this.repo);
		if (!split.ok) return split;
		try {
			const response = await this.client.rest.pulls.get({
				owner: split.value.owner,
				repo: split.value.name,
				pull_number: number,
			});
			const data = response.data;
			if (data.merged_at) return { ok: true, value: "merged" };
			if (data.state === "closed") return { ok: true, value: "closed" };
			if (data.draft) return { ok: true, value: "draft" };
			return { ok: true, value: "open" };
		} catch (err: unknown) {
			return failure(
				`cannot read pull request #${number}: ${err instanceof Error ? err.message : String(err)}`,
				SOURCE,
			);
		}
	}
}
