// ─── GitHub Composition Root (issue #2098) ──────────────────────
// The ONLY module that knows the concrete adapters and the transport. Every
// other module sees `GitHubPort` (ports.ts) or a sub-port.
//
// `createGitHubPort` used to live in ports.ts, which forced the port module to
// import the adapter it was meant to abstract.

import type { GitHubPort } from "./ports.ts";
import { createGitHubTransport, type GitHubTransport } from "./github-transport.ts";
import { OctokitIssues } from "./octokit-issues.ts";
import { OctokitPulls } from "./octokit-pulls.ts";
import { OctokitProjects } from "./octokit-projects.ts";
import { resolveGitHubToken } from "./gh-client.ts";
import { getDebugLogger } from "../lib/debug.ts";

/**
 * Bind the three sub-adapters to one transport and expose them as a single
 * `GitHubPort`. Delegation is pass-through by design: this module is the
 * composition root, not a policy layer.
 */
export function composeGitHubPort(transport: GitHubTransport): GitHubPort {
	const log = getDebugLogger().child("github");
	const issues = new OctokitIssues(transport, log);
	const pulls = new OctokitPulls(transport, log);
	const projects = new OctokitProjects(transport, log);

	return {
		getIssue: (issueNum, repo) => issues.getIssue(issueNum, repo),
		getIssueWithComments: (issueNum, repo) => issues.getIssueWithComments(issueNum, repo),
		listComments: (issueNum, repo) => issues.listComments(issueNum, repo),
		getAuthenticatedLogin: () => issues.getAuthenticatedLogin(),
		closeIssue: (issueNum, repo) => issues.closeIssue(issueNum, repo),
		postIssueComment: (issueNum, repo, body) => issues.postIssueComment(issueNum, repo, body),
		updateIssueComment: (commentId, repo, body) => issues.updateIssueComment(commentId, repo, body),
		getIssueLabels: (issueNum, repo) => issues.getIssueLabels(issueNum, repo),
		addIssueLabel: (issueNum, repo, label) => issues.addIssueLabel(issueNum, repo, label),
		removeIssueLabel: (issueNum, repo, label) => issues.removeIssueLabel(issueNum, repo, label),
		deleteIssueComment: (commentId, repo) => issues.deleteIssueComment(commentId, repo),
		compareBranches: (base, head, repo) => pulls.compareBranches(base, head, repo),
		listPullRequestsForBranch: (branch, repo) => pulls.listPullRequestsForBranch(branch, repo),
		createPullRequest: (input) => pulls.createPullRequest(input),
		updatePullRequest: (prNumber, repo, body, title) =>
			pulls.updatePullRequest(prNumber, repo, body, title),
		getProjectFields: (projectNumber) => projects.getProjectFields(projectNumber),
		getProjectItems: (projectNumber) => projects.getProjectItems(projectNumber),
		getProjectId: (projectNumber) => projects.getProjectId(projectNumber),
		setItemStatusField: (itemId, projectId, fieldId, optionId) =>
			projects.setItemStatusField(itemId, projectId, fieldId, optionId),
		checkBlockedByDependencies: (issueNum, repo) =>
			pulls.checkBlockedByDependencies(issueNum, repo),
		getClosingPrsForIssue: (issueNum, repo) => pulls.getClosingPrsForIssue(issueNum, repo),
		setToken: (token) => transport.setToken(token),
	};
}

/**
 * Create a GitHubPort instance. Auth resolves from the injected literal when
 * provided, else from `resolveGitHubToken()` (env or hosts.yml). Throws if
 * no token is found — fail closed.
 */
export function createGitHubPort(token?: string): GitHubPort {
	const resolved = token ?? resolveGitHubToken();
	if (!resolved) {
		throw new Error(
			"GitHub token not found. Set GH_TOKEN environment variable or " +
				"ensure ~/.config/gh/hosts.yml contains a valid oauth_token for github.com.",
		);
	}
	return composeGitHubPort(createGitHubTransport(resolved));
}
