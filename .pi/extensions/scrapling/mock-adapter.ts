/**
 * MockAdapter — In-process mock CrawlerEngine for testing
 *
 * Returns a pre-configured canned CrawlResult on every call.
 * Ignores params and signal — useful for testing handler delegation
 * without a real Python subprocess.
 */

import type { CrawlerEngine } from "./crawler-engine.ts";
import type { CrawlParams, CrawlResult } from "./types.ts";

export class MockAdapter implements CrawlerEngine {
	private readonly result: CrawlResult;

	constructor(result: CrawlResult) {
		this.result = result;
	}

	async crawl(_params: CrawlParams & { signal?: AbortSignal }): Promise<CrawlResult> {
		return this.result;
	}
}
