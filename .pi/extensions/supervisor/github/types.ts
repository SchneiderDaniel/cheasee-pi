// ─── GitHub Module Types ─────────────────────────────────────────
// Typed wrappers for ghJson/ghGraphQL and GraphQL response shapes.

// ─── GhClient interface ───────────────────────────────────────────

interface GhClient {
	gh(
		pi: ExtensionAPI,
		args: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string>;
	ghJson<T = unknown>(
		pi: ExtensionAPI,
		args: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<T | null>;
	ghGraphQL<T = unknown>(
		pi: ExtensionAPI,
		query: string,
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<T | null>;
}

// ─── GraphQL Response Types ───────────────────────────────────────

export interface ProjectFieldsResponse {
	data?: {
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
	};
	errors?: Array<{ message: string }>;
}

export interface ProjectItemsResponse {
	data?: {
		viewer?: {
			projectV2?: {
				items?: {
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
				};
			};
		};
	};
	errors?: Array<{ message: string }>;
}

export interface ProjectIdResponse {
	data?: {
		viewer?: {
			projectV2?: {
				id: string;
			};
		};
	};
	errors?: Array<{ message: string }>;
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
