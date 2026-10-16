// ─── Octokit GraphQL Queries ─────────────────────────────────────
// GraphQL query builders + response shapes for OctokitClient. Split out of
// octokit-client.ts (issue #2001); queries are adapter-local and no Octokit
// types leak inward.

import type { GhTimelineNode, ProjectFieldValueNode } from "../config/types.ts";

// ─── GraphQL Query Strings ──────────────────────────────────────

export const PROJECT_FIELDS_QUERY = (projectNumber: number) => `{
	viewer {
		projectV2(number: ${projectNumber}) {
			fields(first: 10) {
				nodes {
					... on ProjectV2Field { id name dataType }
					... on ProjectV2SingleSelectField { id name dataType options { id name } }
					... on ProjectV2IterationField { id name dataType }
				}
			}
		}
	}
}`;

export const PROJECT_ITEMS_QUERY = (projectNumber: number, after: string | null) => {
	const afterArg = after ? `, after: "${after}"` : "";
	return `{
	viewer {
		projectV2(number: ${projectNumber}) {
			items(first: 100${afterArg}) {
				pageInfo { hasNextPage endCursor }
				nodes {
					id
					content {
						... on Issue { number url }
						... on PullRequest { number url }
					}
					fieldValues(first: 20) {
						nodes {
							... on ProjectV2ItemFieldSingleSelectValue {
								name
								field { ... on ProjectV2FieldCommon { id name } }
							}
							... on ProjectV2ItemFieldTextValue {
								text
								field { ... on ProjectV2FieldCommon { id name } }
							}
						}
					}
				}
			}
		}
	}
}`;
};

export const PROJECT_ID_QUERY = (projectNumber: number) => `{
	viewer {
		projectV2(number: ${projectNumber}) {
			id
		}
	}
}`;

export const DEPENDENCY_TIMELINE_QUERY = (owner: string, name: string, issueNumber: number) => `
	query {
		repository(owner: "${owner}", name: "${name}") {
			issue(number: ${issueNumber}) {
				timelineItems(itemTypes: [BLOCKED_BY_ADDED_EVENT, BLOCKED_BY_REMOVED_EVENT], first: 100) {
					nodes {
						__typename
						... on BlockedByAddedEvent {
							blockingIssue { id number title state }
						}
						... on BlockedByRemovedEvent {
							blockingIssue { id number title state }
						}
					}
				}
			}
		}
	}`;

export const SET_STATUS_MUTATION = (
	itemId: string,
	projectId: string,
	fieldId: string,
	optionId: string,
) => `
	mutation {
		updateProjectV2ItemFieldValue(
			input: {
				projectId: "${projectId}"
				itemId: "${itemId}"
				fieldId: "${fieldId}"
				value: { singleSelectOptionId: "${optionId}" }
			}
		) { clientMutationId }
	}`;

/**
 * Update an issue comment by its GraphQL node id (opaque `IC_…` handle).
 * JSON.stringify produces a valid GraphQL string literal for both id and body.
 */
export const UPDATE_ISSUE_COMMENT_MUTATION = (commentId: string, body: string) => `
	mutation {
		updateIssueComment(input: { id: ${JSON.stringify(commentId)}, body: ${JSON.stringify(body)} }) {
			issueComment { id }
		}
	}`;

// ─── GraphQL Response Types ──────────────────────────────────────

export interface ProjectFieldsResponse {
	viewer?: {
		projectV2?: {
			fields?: {
				nodes?: Array<{
					id: string;
					name: string;
					dataType?: string;
					options?: Array<{ id: string; name: string }>;
				}>;
			};
		};
	};
	errors?: Array<{ message: string }>;
}

export interface ProjectItemsResponse {
	viewer?: {
		projectV2?: {
			items?: {
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
				nodes?: Array<{
					id: string;
					content?: { url?: string; number?: number };
					fieldValues?: {
						nodes?: ProjectFieldValueNode[];
					};
				}>;
			};
		};
	};
	errors?: Array<{ message: string }>;
}

export interface ProjectIdResponse {
	viewer?: {
		projectV2?: {
			id: string;
		};
	};
	errors?: Array<{ message: string }>;
}

export interface DepsTimelineResponse {
	repository?: {
		issue?: {
			timelineItems?: {
				nodes?: GhTimelineNode[];
			};
		};
	};
	errors?: Array<{ message: string }>;
}
