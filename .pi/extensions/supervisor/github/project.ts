// ─── Project Board Operations ─────────────────────────────────────
// getProjectFields, getProjectItems, getProjectId, findIssueItem,
// setItemStatus.

import type { ExecFn } from "../pipeline/helpers.ts";
import type { ProjectField, ProjectItem } from "../config/types.ts";
import { ghGraphQL, gh } from "./gh-client.ts";
import type { ProjectFieldsResponse, ProjectItemsResponse, ProjectIdResponse } from "./types.ts";
import { getDebugLogger } from "../lib/debug.ts";

// ─── Get Project Fields ───────────────────────────────────────────

export async function getProjectFields(
	exec: ExecFn,
	projectNumber: number,
): Promise<ProjectField[]> {
	const log = getDebugLogger();
	log.info("project", `Reading fields for project #${projectNumber}`);
	const resp = await ghGraphQL<ProjectFieldsResponse>(
		exec,
		`{
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
	}`,
	);
	const nodes = resp?.data?.viewer?.projectV2?.fields?.nodes || [];
	const fields = nodes.map((n) => ({
		id: n.id,
		name: n.name,
		type: n.dataType || "UNKNOWN",
		options: n.options || undefined,
	}));
	log.info("project", `Got ${fields.length} fields for project #${projectNumber}`, {
		fieldNames: fields.map((f) => f.name),
	});
	return fields;
}

// ─── Get Project Items (paginated) ────────────────────────────────

export async function getProjectItems(exec: ExecFn, projectNumber: number): Promise<ProjectItem[]> {
	const log = getDebugLogger();
	log.info("project", `Reading items for project #${projectNumber}`);
	const allItems: ProjectItem[] = [];
	let after: string | null = null;
	let hasNextPage = true;
	let pageCount = 0;

	while (hasNextPage) {
		pageCount++;
		const afterArg: string = after ? `, after: "${after}"` : "";
		const resp = await ghGraphQL<ProjectItemsResponse>(
			exec,
			`{
			viewer {
				projectV2(number: ${projectNumber}) {
					items(first: 100${afterArg}) {
						pageInfo {
							hasNextPage
							endCursor
						}
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
		}`,
		);
		const page:
			| {
					pageInfo: { hasNextPage: boolean; endCursor: string | null };
					nodes?: Array<{
						id: string;
						content?: { url?: string; number?: number };
						fieldValues?: {
							nodes?: Array<{
								name?: string;
								text?: string;
								field?: { id: string; name: string };
							}>;
						};
					}>;
			  }
			| undefined = resp?.data?.viewer?.projectV2?.items;
		const nodes = page?.nodes || [];
		for (const n of nodes) {
			const fieldNodes = n.fieldValues?.nodes || [];
			let status: string | undefined;
			const fv: Array<{ fieldId: string; value: string; optionId?: string }> = [];
			for (const f of fieldNodes) {
				if (f.name && f.field?.name?.toLowerCase() === "status") {
					status = f.name;
				}
				if (f.field?.id) {
					fv.push({
						fieldId: f.field.id,
						value: f.name || f.text || "",
						optionId: undefined,
					});
				}
			}
			allItems.push({
				id: n.id,
				status,
				content: n.content
					? {
							url: n.content.url,
							number: n.content.number,
						}
					: undefined,
				fieldValues: fv.length > 0 ? fv : undefined,
			});
		}
		hasNextPage = page?.pageInfo?.hasNextPage ?? false;
		after = page?.pageInfo?.endCursor ?? null;
	}

	log.info(
		"project",
		`Loaded ${allItems.length} items from project #${projectNumber} (${pageCount} pages)`,
	);
	return allItems;
}

// ─── Get Project ID ───────────────────────────────────────────────

export async function getProjectId(exec: ExecFn, projectNumber: number): Promise<string> {
	const log = getDebugLogger();
	log.debug("project", `Get project ID for #${projectNumber}`);
	const resp = await ghGraphQL<ProjectIdResponse>(
		exec,
		`{
		viewer {
			projectV2(number: ${projectNumber}) {
				id
			}
		}
	}`,
	);
	const id = resp?.data?.viewer?.projectV2?.id || "";
	log.debug(
		"project",
		`Project #${projectNumber} ID: ${id ? id.slice(0, 20) + "..." : "NOT FOUND"}`,
	);
	return id;
}

// ─── Set Item Status ──────────────────────────────────────────────

export async function setItemStatus(
	exec: ExecFn,
	itemId: string,
	projectId: string,
	fieldId: string,
	optionId: string,
): Promise<void> {
	const log = getDebugLogger();
	log.info("project", "Setting item status", {
		itemId: itemId.slice(0, 16) + "...",
		optionId: optionId.slice(0, 16) + "...",
	});
	await gh(exec, [
		"project",
		"item-edit",
		"--id",
		itemId,
		"--project-id",
		projectId,
		"--field-id",
		fieldId,
		"--single-select-option-id",
		optionId,
	]);
	log.info("project", "Item status updated");
}
