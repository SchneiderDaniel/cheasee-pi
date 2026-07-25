/**
 * web_crawl — Web page crawling and content extraction via Scrapling
 *
 * Uses PythonAdapter (concrete) for subprocess orchestration.
 * Handler owns presentation concerns only:
 *   - URL validation
 *   - Concurrency semaphore (MAX_CONCURRENT_CRAWLS = 2) for RAM protection
 *   - Result formatting for LLM
 *   - onUpdate progress
 *
 * Injection seam: setCrawlFactory/resetCrawlFactory for tests.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PythonAdapter, type CrawlFn } from "./python-adapter.ts";
import { ensureScraplingVenv } from "./venv-setup.ts";

// Concurrency lock: Max 2 simultaneous web crawls to protect 8GB RAM
let activeCrawls = 0;
const MAX_CONCURRENT_CRAWLS = 2;

async function acquireCrawlLock(signal?: AbortSignal): Promise<void> {
	while (activeCrawls >= MAX_CONCURRENT_CRAWLS) {
		signal?.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	activeCrawls++;
}

function releaseCrawlLock(): void {
	activeCrawls = Math.max(0, activeCrawls - 1);
}

// URL validation — only http/https allowed for subprocess safety
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validate a URL string for web crawling.
 * Accepts only http: and https: protocols. Rejects non-HTTP schemes
 * (file:, data:, ftp:, javascript:, etc.) before reaching the fetcher subprocess.
 *
 * @param raw - URL string to validate
 * @returns parsed URL object (valid http/https)
 * @throws Error("Invalid URL") for parse failures
 * @throws Error with scheme name for disallowed protocols
 */
export function validateUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("Invalid URL");
	}
	if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
		throw new Error(
			`Invalid URL: only http and https protocols are allowed (got ${parsed.protocol})`,
		);
	}
	return parsed;
}

// ── Factory injection seam (replaces CrawlerEngine port + MockAdapter) ──

let injectedCrawl: CrawlFn | undefined;

/**
 * Override the default crawl factory with a custom function.
 * Used by tests to inject canned CrawlResult values without
 * subprocess, venv, or module mocking.
 *
 * @param fn - CrawlFn to use, or undefined to reset
 * @throws TypeError if fn is undefined
 */
export function setCrawlFactory(fn: CrawlFn): void {
	if (fn === undefined) {
		throw new TypeError("setCrawlFactory requires a CrawlFn argument");
	}
	injectedCrawl = fn;
}

/**
 * Reset the injected crawl factory to use the default PythonAdapter.
 * Must be called in afterEach to prevent cross-test bleed.
 */
export function resetCrawlFactory(): void {
	injectedCrawl = undefined;
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
			url: Type.String({
				description: "URL to crawl (e.g. https://example.com)",
				pattern: "^(https?|HTTPS?)://",
			}),
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
			await acquireCrawlLock(signal);

			try {
				const maxPages = Math.min(Math.max(1, params.maxPages ?? 1), 10);

				// URL validation — reject invalid URLs and non-HTTP schemes early
				validateUrl(params.url);

				onUpdate?.({
					content: [{ type: "text", text: `Crawling ${params.url} …` }],
					details: {} as Record<string, unknown>,
				});

				// Delegate to crawl factory (injectable for tests)
				const crawlFn: CrawlFn =
					injectedCrawl ??
					(async (p) => {
						const engine = new PythonAdapter(pi.exec, _ctx.cwd, onUpdate, ensureScraplingVenv);
						return engine.crawl(p);
					});
				const result = await crawlFn({
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
				// Note: Token truncation is handled by PythonAdapter; handler uses content as-is
				const texts = result.results.map((r) => {
					const content = r.markdown || "[No content]";
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
