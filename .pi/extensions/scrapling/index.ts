/**
 * web_crawl — Web page crawling and content extraction via Scrapling
 *
 * Uses CrawlerEngine port with PythonAdapter (production) for subprocess
 * orchestration. Handler owns presentation concerns only:
 *   - URL validation
 *   - Concurrency semaphore (MAX_CONCURRENT_CRAWLS = 2) for RAM protection
 *   - Result formatting for LLM
 *   - onUpdate progress
 *
 * Convenience: 3-line execute body delegates to CrawlerEngine.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PythonAdapter } from "./python-adapter.ts";

// Concurrency lock: Max 2 simultaneous web crawls to protect 8GB RAM
let activeCrawls = 0;
const MAX_CONCURRENT_CRAWLS = 2;

async function acquireCrawlLock(): Promise<void> {
	while (activeCrawls >= MAX_CONCURRENT_CRAWLS) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	activeCrawls++;
}

function releaseCrawlLock(): void {
	activeCrawls = Math.max(0, activeCrawls - 1);
}

export default function webCrawlExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_crawl",
		label: "Web Crawl",
		description:
			"Crawl web pages. Uses lightweight fetcher normally, " +
			"automatically bypasses Cloudflare if blocked.",
		promptSnippet:
			"Crawl web pages and extract content as Markdown, with automatic Cloudflare bypass",
		promptGuidelines: [
			"Use web_crawl for public web pages, especially behind Cloudflare or bot protection; prefer read for local files and bash curl for simple API calls without anti-bot measures.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to crawl (e.g. https://example.com)" }),
			maxPages: Type.Optional(
				Type.Number({
					default: 1,
					description: "Maximum pages to crawl (default 1, max 10)",
				}),
			),
			maxTokens: Type.Optional(
				Type.Number({
					description:
						"Hard token limit per page (rough estimate). Content beyond limit is truncated with notice. 0 = no limit.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			await acquireCrawlLock();

			try {
				const maxPages = Math.min(Math.max(1, params.maxPages ?? 1), 10);

				// URL validation — reject invalid URLs early
				try {
					new URL(params.url);
				} catch {
					throw new Error("Invalid URL");
				}

				onUpdate?.({
					content: [{ type: "text", text: `Crawling ${params.url} …` }],
					details: {} as Record<string, unknown>,
				});

				// Delegate to CrawlerEngine (3 lines)
				const engine = new PythonAdapter(pi.exec, _ctx.cwd, onUpdate);
				const result = await engine.crawl({
					url: params.url,
					maxPages,
					maxTokens: params.maxTokens,
					signal,
				});

				// Handle engine result — throw on error to preserve signaling contract
				if (!result.success) {
					throw new Error(result.error);
				}

				// Format successful results for LLM
				const texts = result.results.map((r) => {
					let content = r.markdown || "[No content]";
					if (params.maxTokens && params.maxTokens > 0) {
						const estimatedTokens = Math.round(content.length / 4);
						if (estimatedTokens > params.maxTokens) {
							const maxChars = params.maxTokens * 4;
							const truncated = content.slice(0, maxChars);
							content = `${truncated}\n\n[... truncated at ~${params.maxTokens.toLocaleString()} tokens (${estimatedTokens.toLocaleString()} total). Use narrower query or page-specific section.]`;
						}
					}
					return `--- ${r.url} (via ${r.method}) ---\n${content}`;
				});

				return {
					content: [{ type: "text", text: texts.join("\n\n") }],
					details: {} as Record<string, unknown>,
				};
			} finally {
				releaseCrawlLock();
			}
		},
	});
}
