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
 * JSON Schema of `web_search`'s `structuredContent`, declared as the tool's
 * `outputSchema`. Discriminated on `ok` so every terminal return path — success
 * and `isError` — conforms to the declared contract (mirrors scrapling's
 * `crawlOutputSchema`). Programmatic (codemode) callers receive this payload
 * instead of the model-facing text.
 */
export const WebSearchOutputSchema = Type.Union([
	Type.Object({
		ok: Type.Literal(true),
		query: Type.String(),
		returned: Type.Number(),
		results: Type.Array(
			Type.Object({
				title: Type.String(),
				url: Type.String(),
				snippet: Type.String(),
			}),
		),
	}),
	Type.Object({
		ok: Type.Literal(false),
		query: Type.String(),
		error: Type.String(),
	}),
]);

/**
 * Structured output payload emitted on every terminal return path. Derived from
 * {@link WebSearchOutputSchema} so the schema and type cannot drift; the union
 * covers the success (`ok: true`) and error (`ok: false`) branches.
 */
export type WebSearchPayload = Static<typeof WebSearchOutputSchema>;

export interface SearchParams {
	query: string;
	maxResults?: number;
	proxy?: string;
}

export interface SearchCacheEntry {
	results: SearchResult[];
	timestamp: number;
}
