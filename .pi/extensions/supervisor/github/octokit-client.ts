// ─── Octokit client — compatibility shim (issue #2098) ───────────
// This module used to be the GitHub adapter God Object (17 own methods:
// issue REST, pull/dependency REST, ProjectV2 GraphQL, token handling). The
// port split (issue #2098) moved every responsibility out:
//
//   issue REST ops        → octokit-issues.ts (OctokitIssues + IssueOpsBase)
//   pull/dependency ops   → octokit-pulls.ts  (OctokitPulls)
//   ProjectV2 GraphQL ops → octokit-projects.ts (OctokitProjects)
//   token + REST/GraphQL  → github-transport.ts (GitHubTransport)
//   wiring + factory      → compose.ts (composeGitHubPort / createGitHubPort)
//
// What remains is an explicit re-export barrel so pre-split import paths keep
// resolving. No logic, no Octokit construction, no state: see compose.ts for
// the single composition root.
//
// See also: .pi/extensions/supervisor/test/github/github-split-boundaries.test.mts

export { OctokitIssues } from "./octokit-issues.ts";
export { OctokitPulls } from "./octokit-pulls.ts";
export { OctokitProjects } from "./octokit-projects.ts";
export { createGitHubTransport } from "./github-transport.ts";
export type { GitHubTransport } from "./github-transport.ts";
export { composeGitHubPort, createGitHubPort } from "./compose.ts";
export { mapRestPrToConflictInfo } from "./parsers.ts";
