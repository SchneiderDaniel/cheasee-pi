// ─── GitHub Module Entry ─────────────────────────────────────────
// Re-exports all github submodules.

export { gh, ghJson, ghGraphQL } from "./gh-client.ts";
export type { GhClient } from "./types.ts";
export type { ProjectFieldsResponse, ProjectItemsResponse, ProjectIdResponse } from "./types.ts";
export {
	getProjectFields,
	getProjectItems,
	getProjectId,
	findIssueItem,
	setItemStatus,
} from "./project.ts";
export { checkBlockedByDependencies } from "./deps.ts";
export { checkPrConflicts, createPullRequest } from "./pr.ts";
export {
	postIssueComment,
	filterIssueData,
	extractAgentCommentBody,
	extractStructuredAuditOutput,
} from "./comment.ts";
export type { StructuredAuditOutput, RawIssueData } from "./comment.ts";
export { commitChanges, pushBranch, commitAndPush } from "./git.ts";
