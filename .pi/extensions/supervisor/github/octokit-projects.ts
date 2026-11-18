// ─── Octokit Projects Adapter (issue #2098) ──────────────────────
// ProjectV2 GraphQL operations over the shared GitHubTransport. The
// pagination loop keeps the cursor threading; response→domain mapping is
// delegated to the pure `mapProjectItemsPage` so it stays unit-testable
// without network mocks.

import type { ProjectField, ProjectItem } from "../config/types.ts";
import type { ProjectPort } from "./ports.ts";
import { RepoAdapterBase } from "./adapter-base.ts";
import { mapProjectItemsPage } from "./parsers.ts";
import {
	PROJECT_FIELDS_QUERY,
	PROJECT_ITEMS_QUERY,
	PROJECT_ID_QUERY,
	SET_STATUS_MUTATION,
	type ProjectFieldsResponse,
	type ProjectItemsResponse,
	type ProjectIdResponse,
} from "./octokit-queries.ts";

export class OctokitProjects extends RepoAdapterBase implements ProjectPort {
	async getProjectFields(projectNumber: number): Promise<ProjectField[]> {
		this.log.debug("octokit", `getProjectFields #${projectNumber}`);
		const resp = await this.transport.query<ProjectFieldsResponse>(
			PROJECT_FIELDS_QUERY(projectNumber),
		);
		const nodes = resp?.viewer?.projectV2?.fields?.nodes || [];
		return nodes.map((n) => ({
			id: n.id,
			name: n.name,
			type: n.dataType || "UNKNOWN",
			options: n.options || undefined,
		}));
	}

	async getProjectItems(projectNumber: number): Promise<ProjectItem[]> {
		this.log.debug("octokit", `getProjectItems #${projectNumber}`);
		const allItems: ProjectItem[] = [];
		let after: string | null = null;
		let hasNextPage = true;

		while (hasNextPage) {
			const resp = await this.transport.query<ProjectItemsResponse>(
				PROJECT_ITEMS_QUERY(projectNumber, after),
			);
			const page = mapProjectItemsPage(resp?.viewer?.projectV2?.items);
			allItems.push(...page.items);
			hasNextPage = page.hasNextPage;
			after = page.endCursor;
		}

		return allItems;
	}

	async getProjectId(projectNumber: number): Promise<string> {
		this.log.debug("octokit", `getProjectId #${projectNumber}`);
		const resp = await this.transport.query<ProjectIdResponse>(PROJECT_ID_QUERY(projectNumber));
		return resp?.viewer?.projectV2?.id || "";
	}

	async setItemStatusField(
		itemId: string,
		projectId: string,
		fieldId: string,
		optionId: string,
	): Promise<void> {
		this.log.debug("octokit", "setItemStatusField", {
			itemId: itemId.slice(0, 16) + "...",
			optionId: optionId.slice(0, 16) + "...",
		});
		await this.transport.query(SET_STATUS_MUTATION(itemId, projectId, fieldId, optionId));
	}
}
