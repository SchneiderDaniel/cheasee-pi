// ─── Octokit Pulls Adapter (issue #2098) ─────────────────────────
// Pull-request and dependency operations over the shared GitHubTransport.
//
// Known adjacent defects, characterized (not fixed) by the test suite:
//   - listPullRequestsForBranch hardcodes base 'main' as adapter policy
//   - getClosingPrsForIssue fabricates a placeholder when PR details fail
// Both are tracked as separate issues.

import type { DepsResult, PrConflictInfo } from "../config/types.ts";
import type { ClosingPrRef, PullPort } from "./ports.ts";
import { RepoAdapterBase } from "./adapter-base.ts";
import { parseDepsTimeline, mapRestPrToConflictInfo, mapPrToClosingRef } from "./parsers.ts";
import { DEPENDENCY_TIMELINE_QUERY, type DepsTimelineResponse } from "./octokit-queries.ts";

export class OctokitPulls extends RepoAdapterBase implements PullPort {
	async compareBranches(base: string, head: string, repo: string): Promise<number> {
		const { owner, name } = this.parseRepo(repo);

		this.log.debug("octokit", `compareBranches ${base}...${head}`);
		const resp = await this.transport.octokit.repos.compareCommits({
			owner,
			repo: name,
			base,
			head,
		});
		return resp.data.ahead_by;
	}

	async listPullRequestsForBranch(branch: string, repo: string): Promise<PrConflictInfo | null> {
		const { owner, name } = this.parseRepo(repo);

		this.log.debug("octokit", `listPullRequestsForBranch ${branch}`);
		const resp = await this.transport.octokit.pulls.list({
			owner,
			repo: name,
			head: `${owner}:${branch}`,
			state: "open",
			per_page: 1,
		});
		const prs = resp.data;
		if (!prs || prs.length === 0) return null;

		return mapRestPrToConflictInfo(prs[0]! as Record<string, unknown>, branch, "main");
	}

	async createPullRequest(input: {
		repo: string;
		base: string;
		head: string;
		title: string;
		body?: string;
	}): Promise<{ number: number }> {
		const { owner, name } = this.parseRepo(input.repo);

		this.log.debug("octokit", `createPullRequest ${input.head} → ${input.base}`);
		const resp = await this.transport.octokit.pulls.create({
			owner,
			repo: name,
			base: input.base,
			head: input.head,
			title: input.title,
			body: input.body,
		});
		return { number: resp.data.number };
	}

	async updatePullRequest(
		prNumber: number,
		repo: string,
		body: string,
		title?: string,
	): Promise<void> {
		const { owner, name } = this.parseRepo(repo);

		this.log.debug("octokit", `updatePullRequest #${prNumber}`);
		await this.transport.octokit.pulls.update({
			owner,
			repo: name,
			pull_number: prNumber,
			body,
			title,
		});
	}

	async checkBlockedByDependencies(issueNum: number, repo: string): Promise<DepsResult> {
		const { owner, name } = this.parseRepo(repo);

		this.log.debug("octokit", `checkBlockedByDependencies #${issueNum}`);
		const resp = await this.transport.query<DepsTimelineResponse>(
			DEPENDENCY_TIMELINE_QUERY(owner, name, issueNum),
		);

		if (resp?.errors && resp.errors.length > 0) {
			const msgs = resp.errors.map((e) => e.message).join("; ");
			throw new Error(`GitHub GraphQL error: ${msgs}`);
		}

		const nodes = resp?.repository?.issue?.timelineItems?.nodes;
		return parseDepsTimeline(nodes);
	}

	async getClosingPrsForIssue(issueNum: number, repo: string): Promise<ClosingPrRef[]> {
		const { owner, name } = this.parseRepo(repo);

		this.log.debug("octokit", `getClosingPrsForIssue #${issueNum}`);

		try {
			// Search for ALL PRs referencing this issue (open, closed, merged).
			// The handler filters by state as needed: open PRs for case 3 (leave
			// open for review), merged/closed PRs for case 2 (resolved-by info).
			const resp = await this.transport.octokit.search.issuesAndPullRequests({
				q: `repo:${owner}/${name} "#${issueNum}" type:pr`,
				sort: "updated",
				order: "desc",
				per_page: 5,
			});

			const refs: ClosingPrRef[] = [];
			for (const item of resp.data.items) {
				if (!item.number) continue;

				// Get detailed PR info to find head branch, merge commit, and state
				try {
					const prResp = await this.transport.octokit.pulls.get({
						owner,
						repo: name,
						pull_number: item.number,
					});
					// Response → domain translation lives in the pure mapper so the
					// merged/closed/open + closing-keyword rules stay unit-testable.
					refs.push(mapPrToClosingRef(prResp.data, issueNum));
				} catch {
					// If we can't get PR details, still include with empty sha/branch
					refs.push({
						number: item.number,
						sha: "",
						source: "branch-head",
						branch: "",
						state: "open",
					});
				}
			}

			return refs;
		} catch (err: unknown) {
			// Fail-open: log warning and return empty array
			const msg = err instanceof Error ? err.message : String(err);
			this.log.warn("octokit", `getClosingPrsForIssue failed: ${msg}`);
			return [];
		}
	}
}
