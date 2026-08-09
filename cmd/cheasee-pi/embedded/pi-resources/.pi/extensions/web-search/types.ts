/**
 * Shared types for web-search extension
 *
 * SearchResult matches ddgs return shape { title, href, body }
 * SearchParams defines tool input shape
 * SearchCacheEntry provides in-session caching
 */

export type { ExecResult, ExecFn, OnUpdateCallback } from "../lib/port-types.ts";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchParams {
	query: string;
	maxResults?: number;
	proxy?: string;
}

export interface SearchCacheEntry {
	results: SearchResult[];
	timestamp: number;
}
