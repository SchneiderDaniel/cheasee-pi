/**
 * CodeFlow report transport — fetch the analysis from the compose-internal
 * codeflow shim and save it as local artifacts.
 *
 * Transport only: resolve the endpoint, GET `/api/analysis/report` (markdown)
 * and `/api/analysis/report.json` (structured), write the bytes atomically to
 * `ignore/codeflow-report.md` and `ignore/codeflow-report.json`. Interpretation
 * (parsing, file-conflict grouping, issue filing) is owned by the
 * codeflow-analysis skill, which reads the artifacts this module produces.
 *
 * Both artifacts matter: the markdown exporter omits duplicates, layer
 * violations and suggestions, so the JSON export is the only source for those
 * issue categories. JSON is treated as best-effort (older bridges may not post
 * it) — its absence never blocks the markdown report.
 *
 * Split by responsibility (issue #2033): HTTP in bridge-client.ts, the
 * filesystem in report-store.ts, body classification in report-body-policy.ts,
 * the JSON-route rules in report-json-route.ts. This module keeps the use case.
 *
 * `scripts/fetch-report.mts` is the CLI delivery adapter over this use-case.
 *
 * Test seams (module-scoped, reset in tests):
 *   setFetchFactory      — swap the HTTP client
 *   setWriteFileFactory  — inject a write failure
 *   resetReportCache     — clear the session cache
 */

import { codeflowServiceUrl } from "../../../extensions/lib/codeflow-endpoint.ts";
import { resolveWithinRoot } from "../../../extensions/lib/path-containment.ts";
import { JSON_ONLY_CATEGORIES } from "./report.ts";
import { getReport } from "./bridge-client.ts";
import { classifyReportBody, applyMarkdownRoute } from "./report-body-policy.ts";
import { fetchJsonRoute } from "./report-json-route.ts";
import { resolveMissingReport } from "./report-missing.ts";
import { REPORT_JSON_REL_PATH, REPORT_REL_PATH } from "./report-paths.ts";
import { defaultWriteFile, removeStaleArtifact, writeAtomically } from "./report-store.ts";
import type { FetchFn, ReportOutcome, ReportResult, WriteFileFn } from "./report-types.ts";

export { REPORT_JSON_REL_PATH, REPORT_REL_PATH };
export { classifyReportBody };
export type { ReportOutcome, ReportResult };

const defaultFetch: FetchFn = (url, init) => fetch(url, init);

let fetchFn: FetchFn = defaultFetch;
let writeFileFn: WriteFileFn = defaultWriteFile;
let cache: ReportResult | null = null;
let cacheCwd: string | null = null;

/** Override the HTTP client (tests); pass nothing to restore the default. */
export function setFetchFactory(fn?: FetchFn): void {
	fetchFn = fn ?? defaultFetch;
}

/** Override the low-level file write (tests); pass nothing to restore. */
export function setWriteFileFactory(fn?: WriteFileFn): void {
	writeFileFn = fn ?? defaultWriteFile;
}

/** Clear the single-slot session cache. */
export function resetReportCache(): void {
	cache = null;
	cacheCwd = null;
}

/** `X-Codeflow-Analysis-At` (epoch ms) → number, or null when absent/malformed. */
export function parseAnalyzedAt(raw: string | null | undefined): number | null {
	if (raw === null || raw === undefined || raw.trim() === "") return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Fetch both report artifacts and persist them. A 404 on the markdown route
 * means the browser has not bridged an analysis yet — returned as an
 * actionable `{ ok: false, status: 404 }`. JSON is optional; its failures are
 * surfaced as warnings but never hide an available markdown report.
 */
export async function fetchAndStoreReport(opts: {
	cwd: string;
	refresh?: boolean;
	signal?: AbortSignal;
	/** Internal: set false on the post-run re-fetch so a run is triggered once. */
	runOnMissing?: boolean;
}): Promise<ReportOutcome> {
	if (!opts.refresh && cache && cacheCwd === opts.cwd) return { ok: true, result: cache };

	const base = codeflowServiceUrl();
	const url = `${base}/api/analysis/report`;

	const resp = await getReport(fetchFn, url, opts.signal);
	opts.signal?.throwIfAborted();

	if (resp.status === 404) {
		// The report slot is empty — the sidecar may fill it headlessly.
		const missing = await resolveMissingReport(fetchFn, base, opts.signal, opts.runOnMissing);
		if (!missing.retry) return missing.outcome;
		return fetchAndStoreReport({ ...opts, refresh: true, runOnMissing: false });
	}
	if (!resp.ok) {
		return {
			ok: false,
			status: resp.status,
			message: `CodeFlow report fetch failed: HTTP ${resp.status} from ${url}`,
		};
	}

	const bytes = new Uint8Array(await resp.arrayBuffer());
	const analyzedAt = parseAnalyzedAt(resp.headers.get("X-Codeflow-Analysis-At"));

	const target = resolveWithinRoot(opts.cwd, REPORT_REL_PATH);

	const markdown = applyMarkdownRoute(bytes, analyzedAt);
	const warnings = [...markdown.warnings];
	writeAtomically(writeFileFn, opts.cwd, target, markdown.markdownBytes);

	const jsonRoute = await fetchJsonRoute(fetchFn, base, opts.signal, markdown.recoveredBytes);
	warnings.push(...jsonRoute.warnings);

	let jsonPath: string | null = null;
	const jsonTarget = resolveWithinRoot(opts.cwd, REPORT_JSON_REL_PATH);
	if (jsonRoute.jsonBytes !== null) {
		writeAtomically(writeFileFn, opts.cwd, jsonTarget, jsonRoute.jsonBytes);
		jsonPath = jsonTarget;
	} else if (removeStaleArtifact(opts.cwd, jsonTarget)) {
		warnings.push(
			"Removed a stale structured JSON artifact left by an earlier analysis, so it cannot be mistaken for this report's JSON.",
		);
	}

	const partial = jsonPath === null;
	// A JSON-less run must name the categories it cannot see; a warning already
	// carrying the list (from `jsonUnavailableWarning`) is enough.
	if (
		partial &&
		!warnings.some((w) => w.includes("duplicates, layer violations and suggestions"))
	) {
		warnings.push(
			`Structured JSON report unavailable, so ${JSON_ONLY_CATEGORIES.join(", ")} categories cannot be extracted.`,
		);
	}

	const result: ReportResult = {
		path: target,
		jsonPath,
		bytes: markdown.markdownBytes.length,
		analyzedAt,
		warnings,
		partial,
		unavailableCategories: partial ? [...JSON_ONLY_CATEGORIES] : [],
		recoveredFromMarkdownRoute: markdown.recoveredBytes !== null,
	};
	cache = result;
	cacheCwd = opts.cwd;
	return { ok: true, result };
}
