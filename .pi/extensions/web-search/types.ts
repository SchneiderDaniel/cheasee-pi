/**
 * Shared types for web-search extension
 *
 * SearchResult matches ddgs return shape { title, href, body }
 * SearchParams defines tool input shape
 * SearchCacheEntry provides in-session caching
 */

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ExecFn {
	(
		cmd: string,
		args: string[],
		opts?: { timeout?: number; signal?: AbortSignal },
	): Promise<ExecResult>;
}

export interface OnUpdateCallback {
	(u: { content: Array<{ type: "text"; text: string }>; details: unknown }): void;
}

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
