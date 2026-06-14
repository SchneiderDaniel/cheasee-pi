/**
 * CrawlerEngine — Port interface for web crawling
 *
 * Defines the seam between handler (presentation) and infrastructure adapters.
 * One method: crawl() with CrawlParams + optional AbortSignal → CrawlResult.
 *
 * Adapters:
 *   - PythonAdapter (production): subprocess call to Scrapling
 *   - MockAdapter (test): canned results for unit tests
 */

import type { CrawlParams, CrawlResult } from "./types.ts";

export interface CrawlerEngine {
	/**
	 * Crawl web pages and extract content as Markdown.
	 *
	 * @param params - URL, max pages, optional maxTokens for truncation
	 * @param params.signal - Optional AbortSignal for cancellation
	 * @returns Promise resolving to a discriminated CrawlResult
	 */
	crawl(params: CrawlParams & { signal?: AbortSignal }): Promise<CrawlResult>;
}
