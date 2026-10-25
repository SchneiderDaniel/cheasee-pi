// ─── Report body classification policy ──────────────────────────
// What a fetched body actually is (JSON export / markdown / other), and how the
// markdown route must be interpreted when the browser bridge misroutes a JSON
// export onto it. Split out of fetch-report.ts (issue #2033).

import { hasStructuredFindings } from "./report.ts";
import { decodeBody, renderRecoveredMarkdown } from "./report-store.ts";

export type ReportFormat = "json" | "markdown" | "other";

/**
 * Classify a report body by content structure, not by the route it arrived on
 * or a substring marker. The JSON export embeds the markdown marker inside its
 * source snippets, and a pre-#1976 bridge can deliver it on the markdown route,
 * so the stable contract is "a JSON object with an `architectureIssues` array".
 * Falls back to the markdown marker, then `other`.
 */
export function classifyReportBody(text: string): ReportFormat {
	const body = text ?? "";
	try {
		const o: unknown = JSON.parse(body);
		if (
			o !== null &&
			typeof o === "object" &&
			!Array.isArray(o) &&
			Array.isArray((o as Record<string, unknown>).architectureIssues)
		) {
			return "json";
		}
	} catch {
		// not JSON — fall through to the markdown marker
	}
	return body.includes("# CodeFlow Analysis Report") ? "markdown" : "other";
}

export interface MarkdownRouteOutcome {
	/** Bytes to persist at the markdown path (never a JSON body). */
	markdownBytes: Uint8Array;
	/** A usable JSON export recovered from the misrouted markdown route, if any. */
	recoveredBytes: Uint8Array | null;
	warnings: string[];
}

/**
 * Interpret the markdown route's body. Defense-in-depth: an old bridge or a
 * manual POST can land a JSON body on the markdown route. Classify by *format*
 * first (so JSON is never written to the markdown path), then gate *usability*
 * on the domain predicate: a JSON body that parses to zero facts (an empty
 * stub) is not a structured export and must not be recovered as one.
 */
export function applyMarkdownRoute(
	bytes: Uint8Array,
	analyzedAt: number | null,
): MarkdownRouteOutcome {
	const warnings: string[] = [];
	const markdownBody = decodeBody(bytes);
	const markdownIsJson = classifyReportBody(markdownBody) === "json";
	const markdownUsable = markdownIsJson && hasStructuredFindings(markdownBody);
	const recoveredBytes: Uint8Array | null = markdownUsable ? bytes : null;
	let markdownBytes: Uint8Array = bytes;
	if (markdownIsJson) {
		warnings.push(
			markdownUsable
				? "The markdown route returned a JSON export body (the browser bridge misrouted " +
						"generateReport('json')); it was recovered as the structured artifact. This shim " +
						"serves no markdown narration, so a placeholder markdown file was written to the " +
						"markdown path."
				: "The markdown route returned a JSON body that yields no findings (a stub), so it " +
						"was not stored as the structured artifact. A placeholder markdown file was written " +
						"to the markdown path.",
		);
		// The JSON body must never sit at the markdown path, but `path` must stay a
		// readable markdown file (Step 1 reads it), so overwrite it with narration.
		markdownBytes = renderRecoveredMarkdown(analyzedAt);
	}
	return { markdownBytes, recoveredBytes, warnings };
}
