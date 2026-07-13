// ─── GitHub Module Types ─────────────────────────────────────────
// Typed wrappers for ghJson/ghGraphQL and GraphQL response shapes.

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


