/**
 * web-search — DuckDuckGo web search tool for researcher agent
 *
 * Provides the web_search tool using ddgs Python library.
 * Runs the ddgs Python script via subprocess with temp file config.
 * Returns ranked list of URLs + snippets from DuckDuckGo search.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SEARCH_SCRIPT } from "./python-script.ts";
import { runSearchScript, parseSearchResults } from "./executor.ts";
import { ensureWebSearchVenv } from "./venv-setup.ts";
import type { SearchCacheEntry } from "./types.ts";

/** In-session cache for search results to avoid redundant lookups */
const searchCache = new Map<string, SearchCacheEntry>();

/** TTL for cache entries in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Concurrency semaphore: Max 5 simultaneous web searches to prevent overwhelming
 * the venv lock and the DDGS API. Follows the same pattern as web_crawl's
 * MAX_CONCURRENT_CRAWLS.
 */
let activeSearches = 0;
const MAX_CONCURRENT_SEARCHES = 5;

async function acquireSearchLock(signal?: AbortSignal): Promise<void> {
	while (activeSearches >= MAX_CONCURRENT_SEARCHES) {
		signal?.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	activeSearches++;
}

function releaseSearchLock(): void {
	activeSearches = Math.max(0, activeSearches - 1);
}

export default function webSearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using DuckDuckGo and return ranked results with URLs and snippets. " +
			"Use this to discover relevant URLs before crawling them with web_crawl. " +
			"Returns [{title, url, snippet}] from DuckDuckGo search. " +
			"Results are cached within a session to avoid redundant lookups.",
		promptSnippet: "Search the web and return ranked results with URLs and snippets via DuckDuckGo",
		promptGuidelines: [
			"- Use web_search to discover relevant URLs before crawling them with web_crawl.",
			"- Results include title, URL, and snippet for each search result.",
			"- Search results are cached within a session to avoid redundant lookups.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (e.g. 'latest rust web framework 2026')",
			}),
			maxResults: Type.Optional(
				Type.Integer({
					default: 10,
					description: "Maximum number of search results (default 10)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const query = params.query.trim();
			if (!query) {
				throw new Error("Search query is empty");
			}
			const maxResults = Math.min(Math.max(1, params.maxResults ?? 10), 50);

			// Check cache first
			const cacheKey = `${query}:${maxResults}`;
			const cached = searchCache.get(cacheKey);
			if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
				const text = formatResults(cached.results);
				return {
					content: [{ type: "text", text }],
					details: {} as Record<string, unknown>,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Searching for "${query}" …` }],
				details: {} as Record<string, unknown>,
			});

			// Acquire concurrency semaphore before starting venv setup/search
			await acquireSearchLock(signal);
			try {
				const cwd = _ctx.cwd;

				// Resolve venv python (auto-creates venv + installs ddgs on first call)
				const python = await ensureWebSearchVenv(pi.exec, cwd, onUpdate);

				const result = await runSearchScript(
					python,
					SEARCH_SCRIPT,
					{ query, max_results: maxResults },
					30_000,
					signal,
					pi.exec,
				);

				if (result.code !== 0) {
					throw new Error(
						`Search failed: python3 error (code ${result.code}): ${result.stderr.slice(0, 500)}`,
					);
				}

				const parsed = parseSearchResults(result.stdout);
				if (!parsed.ok) {
					throw new Error(`Search failed: ${parsed.error}`);
				}

				// Cache results
				searchCache.set(cacheKey, {
					results: parsed.results,
					timestamp: Date.now(),
				});

				// Clean stale cache entries
				for (const [key, entry] of searchCache) {
					if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
						searchCache.delete(key);
					}
				}

				const text = formatResults(parsed.results);
				return {
					content: [{ type: "text", text }],
					details: {} as Record<string, unknown>,
				};
			} finally {
				releaseSearchLock();
			}
		},
	});
}

/**
 * Format search results into readable text for the LLM.
 */
export function formatResults(
	results: Array<{ title: string; url: string; snippet: string }>,
): string {
	if (results.length === 0) {
		return "No results found.";
	}

	const encodeUrl = (url: string) =>
		url.replace(/[()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
	const lines = results.map(
		(r, i) => `${i + 1}. [${r.title}](${encodeUrl(r.url)})\n   ${r.snippet}`,
	);

	return `Search results:\n\n${lines.join("\n\n")}`;
}
