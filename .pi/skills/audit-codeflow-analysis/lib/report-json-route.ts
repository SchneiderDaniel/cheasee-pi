// ─── JSON route resolution ──────────────────────────────────────
// Best-effort fetch of `/api/analysis/report.json`, with the stub/staleness
// rules that keep an incomplete export from displacing a good one. Split out of
// fetch-report.ts (issue #2033).

import { getReport, jsonUnavailableWarning } from "./bridge-client.ts";
import { classifyReportBody } from "./report-body-policy.ts";
import { decodeBody } from "./report-store.ts";
import { hasStructuredFindings } from "./report.ts";
import type { FetchFn } from "./report-types.ts";

export interface JsonRouteOutcome {
	/** Bytes to persist as the structured artifact, or null when unusable. */
	jsonBytes: Uint8Array | null;
	warnings: string[];
}

/**
 * Resolve the structured artifact. `http://…/report.json` wins unless it is a
 * stub or smaller than an export already recovered from the markdown route;
 * every failure is a warning, never an error, because the markdown report alone
 * is still a valid (partial) result.
 */
export async function fetchJsonRoute(
	fetchFn: FetchFn,
	base: string,
	signal: AbortSignal | undefined,
	recoveredBytes: Uint8Array | null,
): Promise<JsonRouteOutcome> {
	const warnings: string[] = [];
	let jsonBytes: Uint8Array | null = recoveredBytes;

	try {
		const jsonResp = await getReport(fetchFn, `${base}/api/analysis/report.json`, signal);
		if (jsonResp.ok) {
			const body = new Uint8Array(await jsonResp.arrayBuffer());
			const bodyText = decodeBody(body);
			if (classifyReportBody(bodyText) !== "json") {
				warnings.push(
					"Structured JSON report route returned a body that is neither the JSON export " +
						"nor markdown; it was not stored as the structured artifact.",
				);
			} else if (!hasStructuredFindings(bodyText)) {
				// A JSON object with an `architectureIssues` array but no facts is a stub,
				// not a report: never let it masquerade as a complete run.
				warnings.push(
					recoveredBytes !== null
						? `The /api/analysis/report.json route served a smaller export (a fact-less stub, ` +
								`${body.length} bytes) than the usable export recovered from the markdown route ` +
								`(${recoveredBytes.length} bytes); the recovered body was kept so no findings are lost.`
						: `The /api/analysis/report.json route served a stub export with no findings ` +
								`(${body.length} bytes); it was not stored, so the JSON-only categories are unavailable.`,
				);
			} else if (recoveredBytes !== null && body.length < recoveredBytes.length) {
				// The recovered body came from the markdown route (a browser misroute);
				// a smaller JSON-route body is a stale or truncated slot, not a richer
				// report. Keep the larger body so a full export is never silently
				// replaced by a stub. shortcut: byte length proxies export richness,
				// upgrade to a finding-count compare if exports can legitimately shrink.
				warnings.push(
					`The /api/analysis/report.json route served a smaller export (${body.length} bytes) ` +
						`than the JSON body recovered from the markdown route (${recoveredBytes.length} bytes); ` +
						"the recovered body was kept so no findings are lost.",
				);
			} else {
				jsonBytes = body;
			}
		} else if (jsonResp.status === 404) {
			if (jsonBytes === null) warnings.push(await jsonUnavailableWarning(fetchFn, base, signal));
		} else if (jsonBytes === null) {
			warnings.push(
				`Structured JSON report unavailable (HTTP ${jsonResp.status}); duplicates, layer violations and suggestions cannot be extracted.`,
			);
		}
	} catch (err) {
		signal?.throwIfAborted();
		if (jsonBytes === null) {
			warnings.push(
				`Structured JSON report fetch failed: ${err instanceof Error ? err.message : String(err)}; duplicates, layer violations and suggestions cannot be extracted.`,
			);
		}
	}

	return { jsonBytes, warnings };
}
