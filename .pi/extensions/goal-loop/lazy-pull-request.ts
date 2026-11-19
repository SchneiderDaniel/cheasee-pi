// ─── Lazy GitHub pull-request port ──────────────────────────────
// Connecting to GitHub only on first use keeps goal state recording available
// when the token or the client module is missing: the refused call becomes a
// failed `Result`, the service pauses the goal with the reason, and the record
// is still saved (R3.AC5).

import type { Result } from "../shared/result.ts";
import { failure } from "../shared/result.ts";
import { GitHubPullRequestAdapter, type OctokitLike } from "./adapters/github-pull-request.ts";
import type { GoalPullRequest } from "./domain/goal-record.ts";
import type { PullRequestPort } from "./application/ports.ts";

const SOURCE = "goal-pr";

/** Load the Octokit clients and build the adapter for `repo`. */
async function connect(repo: string): Promise<GitHubPullRequestAdapter> {
	const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GitHub token not found — set GH_TOKEN to open goal pull requests");
	const [{ Octokit }, { graphql }] = await Promise.all([
		import("@octokit/rest"),
		import("@octokit/graphql"),
	]);
	const client = {
		rest: new Octokit({ auth: token }) as unknown as OctokitLike["rest"],
		graphql: graphql.defaults({
			headers: { authorization: `token ${token}` },
		}) as unknown as OctokitLike["graphql"],
	};
	return new GitHubPullRequestAdapter(client, repo);
}

/** Normalize a thrown connection/client error into a failed `Result`. */
function reconnectError(err: unknown): Result<never> {
	return failure(err instanceof Error ? err.message : String(err), SOURCE);
}

/** {@link PullRequestPort} that connects to GitHub on first use. */
export class LazyPullRequestPort implements PullRequestPort {
	private delegate: GitHubPullRequestAdapter | null = null;

	private readonly repo: string;

	constructor(repo: string) {
		this.repo = repo;
	}

	private async resolve(): Promise<GitHubPullRequestAdapter> {
		if (this.delegate) return this.delegate;
		this.delegate = await connect(this.repo);
		return this.delegate;
	}

	async openDraft(
		input: Parameters<PullRequestPort["openDraft"]>[0],
	): ReturnType<PullRequestPort["openDraft"]> {
		try {
			const delegate = await this.resolve();
			return await delegate.openDraft(input);
		} catch (err: unknown) {
			return reconnectError(err);
		}
	}

	async updateBody(input: {
		number: number;
		body: string;
	}): ReturnType<PullRequestPort["updateBody"]> {
		try {
			const delegate = await this.resolve();
			return await delegate.updateBody(input);
		} catch (err: unknown) {
			return reconnectError(err);
		}
	}

	async markReadyForReview(nodeId: string): ReturnType<PullRequestPort["markReadyForReview"]> {
		try {
			const delegate = await this.resolve();
			return await delegate.markReadyForReview(nodeId);
		} catch (err: unknown) {
			return reconnectError(err);
		}
	}

	async getState(number: number): ReturnType<PullRequestPort["getState"]> {
		try {
			const delegate = await this.resolve();
			return (await delegate.getState(number)) as Result<GoalPullRequest["state"]>;
		} catch (err: unknown) {
			return reconnectError(err);
		}
	}
}
