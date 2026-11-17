// ─── GitHub Composition Root (issue #2098) ──────────────────────
// The ONLY module that knows the concrete adapters and the transport. Every
// other module sees `GitHubPort` (ports.ts) or a sub-port.
//
// `createGitHubPort` used to live in ports.ts, which forced the port module to
// import the adapter it was meant to abstract.
//
// Delegation is `adapter.method.bind(adapter)` rather than a re-declared arrow
// per member: it keeps the exact signature of the adapter method (no chance of
// transposing parameters in a hand-written pass-through) and it keeps this
// module a wiring table instead of a second god object — CodeFlow counts
// function literals per file, so twenty-two forwarding arrows would flag the
// composition root itself.

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
		// Issue REST + comment/label ops.
		getIssue: issues.getIssue.bind(issues),
		getIssueWithComments: issues.getIssueWithComments.bind(issues),
		listComments: issues.listComments.bind(issues),
		getAuthenticatedLogin: issues.getAuthenticatedLogin.bind(issues),
		closeIssue: issues.closeIssue.bind(issues),
		postIssueComment: issues.postIssueComment.bind(issues),
		updateIssueComment: issues.updateIssueComment.bind(issues),
		getIssueLabels: issues.getIssueLabels.bind(issues),
		addIssueLabel: issues.addIssueLabel.bind(issues),
		removeIssueLabel: issues.removeIssueLabel.bind(issues),
		deleteIssueComment: issues.deleteIssueComment.bind(issues),

		// Pull request + dependency ops.
		compareBranches: pulls.compareBranches.bind(pulls),
		listPullRequestsForBranch: pulls.listPullRequestsForBranch.bind(pulls),
		createPullRequest: pulls.createPullRequest.bind(pulls),
		updatePullRequest: pulls.updatePullRequest.bind(pulls),
		checkBlockedByDependencies: pulls.checkBlockedByDependencies.bind(pulls),
		getClosingPrsForIssue: pulls.getClosingPrsForIssue.bind(pulls),

		// Project v2 GraphQL ops.
		getProjectFields: projects.getProjectFields.bind(projects),
		getProjectItems: projects.getProjectItems.bind(projects),
		getProjectId: projects.getProjectId.bind(projects),
		setItemStatusField: projects.setItemStatusField.bind(projects),

		// Auth stays on the transport so both handles swap together.
		setToken: transport.setToken.bind(transport),
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
