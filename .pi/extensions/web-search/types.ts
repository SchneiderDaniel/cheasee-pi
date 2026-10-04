/**
 * Shared types for web-search extension
 *
 * SearchResult matches ddgs return shape { title, href, body }
 * SearchParams defines tool input shape
 * SearchCacheEntry provides in-session caching
 * WebSearchOutputSchema is the JSON Schema of web_search's structuredContent
 */

import { Type, type Static } from "typebox";

export type { ExecResult, ExecFn, OnUpdateCallback } from "../lib/port-types.ts";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/**
 * JSON Schema of `web_search`'s successful `structuredContent`.
 * Declared as the tool's `outputSchema`; programmatic (codemode) callers receive
 * this payload instead of the model-facing text.
 */
export const WebSearchOutputSchema = Type.Object({
	query: Type.String(),
	returned: Type.Number(),
	results: Type.Array(
		Type.Object({
			title: Type.String(),
			url: Type.String(),
			snippet: Type.String(),
		}),
	),
});

/**
 * Structured output payload emitted on every terminal return path. Derived from
 * {@link WebSearchOutputSchema} so the schema and type cannot drift.
 */
export type WebSearchPayload = Static<typeof WebSearchOutputSchema>;

/** Machine-readable error payload returned when the search itself fails. */
export type WebSearchErrorPayload = {
	error: string;
	query: string;
};

export interface SearchParams {
	query: string;
	maxResults?: number;
	proxy?: string;
}

export interface SearchCacheEntry {
	results: SearchResult[];
	timestamp: number;
}
