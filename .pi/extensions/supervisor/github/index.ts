// ─── GitHub Module Entry ─────────────────────────────────────────
// Re-exports consumed through the barrel.

export { getProjectFields, getProjectItems, getProjectId, findIssueItem } from "./project.ts";
export { checkBlockedByDependencies } from "./deps.ts";
export {
	postIssueComment,
	filterIssueData,
	extractAgentCommentBody,
	extractStructuredAuditOutput,
} from "./comment.ts";
export { commitAndPush } from "./git.ts";
