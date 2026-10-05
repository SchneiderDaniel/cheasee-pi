/**
 * structured-output.ts — machine-readable web_crawl result contract.
 *
 * Single source of truth for the tool's `outputSchema` and the projector that
 * turns a CrawlResult into its `structuredContent` payload for programmatic
 * (codemode) callers. `content` remains the model-facing result.
 *
 * Boundary: pure projection only — no I/O, no subprocess, no LLM formatting.
 */

import { Type, type Static } from "typebox";
import type { CrawlResult } from "./types.ts";

const crawledPageSchema = Type.Object({
	url: Type.String(),
	markdown: Type.String(),
	method: Type.Union([Type.Literal("lightweight"), Type.Literal("stealth")]),
	truncated: Type.Boolean(),
});

/**
 * JSON Schema of `web_crawl`'s `structuredContent`.
 * Keeping it beside the TS type (via `Static`) prevents schema/type drift.
 */
export const crawlOutputSchema = Type.Union([
	Type.Object({
		ok: Type.Literal(true),
		pages: Type.Array(crawledPageSchema),
		totalPages: Type.Number(),
		attempted: Type.Number(),
		failed: Type.Array(Type.String()),
		truncated: Type.Boolean(),
	}),
	Type.Object({
		ok: Type.Literal(false),
		error: Type.Object({
			url: Type.String(),
			reason: Type.String(),
		}),
	}),
]);

export type CrawlStructuredOutput = Static<typeof crawlOutputSchema>;

/**
 * Project a CrawlResult into the payload declared by `crawlOutputSchema`.
 * Pure: returns a fresh object and never mutates its input.
 *
 * @param result - adapter result (success or failure)
 * @param requestedUrl - URL the caller asked for; used by the error branch
 */
export function toStructuredContent(
	result: CrawlResult,
	requestedUrl = "",
): CrawlStructuredOutput {
	if (!result.success) {
		return { ok: false, error: { url: requestedUrl, reason: result.error } };
	}
	return {
		ok: true,
		pages: result.results.map((p) => ({
			url: p.url,
			markdown: p.markdown,
			method: p.method,
			truncated: p.truncated,
		})),
		totalPages: result.results.length,
		attempted: result.attempted,
		failed: result.failed,
		truncated: result.results.some((p) => p.truncated),
	};
}
