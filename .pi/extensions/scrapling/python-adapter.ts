/**
 * PythonAdapter — Production CrawlerEngine via Python subprocess
 *
 * Spawns a Python subprocess running the Scrapling script (SCRAPLING_SCRIPT)
 * with args array (no shell, no injection surface). Handles:
 *   - Venv setup via ensureScraplingVenv
 *   - AbortSignal propagation
 *   - JSON parsing with typed error handling (no exceptions for control flow)
 *   - Token truncation with rawLength preservation
 *   - Process group cleanup on exit
 *
 * Boundary: owns subprocess orchestration, NOT business rules (URL validation,
 * concurrency, result formatting — those stay in the handler).
 */

import { ensureScraplingVenv as defaultEnsureVenv } from "./venv-setup.ts";
import { SCRAPLING_SCRIPT } from "./python-script.ts";
import type { CrawlerEngine } from "./crawler-engine.ts";
import type { CrawlParams, CrawlResult, CrawledPage, ExecFn, OnUpdateCallback } from "./types.ts";

// ── Truncation suffix template ──

function truncationSuffix(limit: number, total: number): string {
	return `\n\n[... truncated at ~${limit.toLocaleString()} tokens (${total.toLocaleString()} total). Use narrower query or page-specific section.]`;
}

// ── Constants ──

/** Subprocess timeout — 120s for StealthyFetcher Cloudflare challenges (min 60s) */
const CRAWL_TIMEOUT = 120_000;

/** Subprocess stdout max buffer — 10MB for large crawl results */
const CRAWL_MAX_BUFFER = 10 * 1024 * 1024;

// ── PythonAdapter ──

/** Type for the ensureScraplingVenv function, injectable for testing */
export type EnsureVenvFn = (
	exec: ExecFn,
	cwd: string,
	onUpdate?: OnUpdateCallback,
) => Promise<string>;

export class PythonAdapter implements CrawlerEngine {
	private readonly exec: ExecFn;
	private readonly cwd: string;
	private readonly onUpdate?: OnUpdateCallback;
	private readonly ensureVenv: EnsureVenvFn;

	/**
	 * @param exec - Exec function (typically pi.exec)
	 * @param cwd - Working directory for venv path resolution
	 * @param onUpdate - Optional progress callback for UI updates
	 * @param ensureVenv - Optional ensureScraplingVenv override (for testing)
	 */
	constructor(exec: ExecFn, cwd: string, onUpdate?: OnUpdateCallback, ensureVenv?: EnsureVenvFn) {
		this.exec = exec;
		this.cwd = cwd;
		this.onUpdate = onUpdate;
		this.ensureVenv = ensureVenv ?? defaultEnsureVenv;
	}

	async crawl(params: CrawlParams & { signal?: AbortSignal }): Promise<CrawlResult> {
		try {
			// 1. Ensure Python venv with Scrapling is available
			const python = await this.ensureVenv(this.exec, this.cwd, this.onUpdate);

			// 2. Build config JSON for subprocess
			const config = JSON.stringify({
				url: params.url,
				maxPages: params.maxPages,
				maxTokens: params.maxTokens,
			});

			// 3. Execute via spawn (args array, no shell, with maxBuffer)
			const result = await this.exec(python, ["-c", SCRAPLING_SCRIPT, config], {
				timeout: CRAWL_TIMEOUT,
				signal: params.signal,
				maxBuffer: CRAWL_MAX_BUFFER,
			});

			// 4. Handle non-zero exit — return typed error, don't throw
			if (result.code !== 0) {
				const errorMsg = result.stderr || result.stdout || "Unknown error";
				return { success: false, error: errorMsg };
			}

			// 5. Parse JSON output
			let parsed: { ok?: boolean; results?: unknown[] };
			try {
				parsed = JSON.parse(result.stdout);
			} catch {
				return {
					success: false,
					error: `Failed to parse crawl output: ${result.stderr || "invalid JSON from subprocess"}`,
				};
			}

			// 6. Validate output shape
			if (!parsed.ok || !Array.isArray(parsed.results)) {
				return {
					success: false,
					error: "Unexpected output format from crawler: missing ok or results",
				};
			}

			// 7. Map successful pages to CrawledPage[], collect errors
			const pages: CrawledPage[] = [];
			const errors: string[] = [];
			const maxTokens = params.maxTokens ?? 0;

			for (const r of parsed.results) {
				const item = r as Record<string, unknown>;

				if (item.success === false) {
					errors.push(String(item.error || "Unknown error"));
					continue;
				}

				const url = String(item.url ?? "");
				const rawMarkdown = String(item.markdown ?? "[No content]");
				const method = item.method === "stealth" ? "stealth" : "lightweight";
				const rawLength = rawMarkdown.length;

				// Apply token truncation with rawLength preservation
				let content = rawMarkdown;
				if (maxTokens > 0) {
					const estimatedTokens = Math.round(content.length / 4);
					if (estimatedTokens > maxTokens) {
						const maxChars = maxTokens * 4;
						content = content.slice(0, maxChars) + truncationSuffix(maxTokens, estimatedTokens);
					}
				}

				pages.push({
					url,
					markdown: content,
					method: method as "lightweight" | "stealth",
					rawLength,
				});
			}

			// 8. If no pages succeeded, return error
			if (pages.length === 0) {
				return {
					success: false,
					error: errors.join("; ") || "All pages failed to crawl",
				};
			}

			// 9. Calculate total estimated tokens from raw lengths
			const totalTokens = pages.reduce((sum, p) => sum + Math.round(p.rawLength / 4), 0);

			return { success: true, results: pages, totalTokens };
		} catch (err) {
			// Catch unexpected errors (e.g., ensureScraplingVenv failure)
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, error: message };
		}
	}
}
