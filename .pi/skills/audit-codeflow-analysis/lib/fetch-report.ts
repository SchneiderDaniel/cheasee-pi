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
 * `scripts/fetch-report.mts` is the CLI delivery adapter over this use-case.
 *
 * Test seams (module-scoped, reset in tests):
 *   setFetchFactory      — swap the HTTP client
 *   setWriteFileFactory  — inject a write failure
 *   resetReportCache     — clear the session cache
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { codeflowServiceUrl } from "../../../extensions/lib/codeflow-endpoint.ts";
import { isPathWithinBase, resolveWithinRoot } from "../../../extensions/lib/path-containment.ts";
import { ensureReport } from "./codeflow-run.ts";

/** Markdown artifact path, relative to the session cwd (gitignored). */
export const REPORT_REL_PATH = "ignore/codeflow-report.md";
/** Structured JSON artifact path, relative to the session cwd (gitignored). */
export const REPORT_JSON_REL_PATH = "ignore/codeflow-report.json";

interface ReportResult {
	path: string;
	jsonPath: string | null;
	bytes: number;
	analyzedAt: number | null;
	warnings: string[];
	/** True when no structured JSON artifact was stored; the run cannot see the JSON-only categories. */
	partial: boolean;
	/** Categories the markdown exporter never emits, empty when a JSON artifact was stored. */
	unavailableCategories: string[];
	/** True when a misrouted JSON body was recovered from the markdown route. */
	recoveredFromMarkdownRoute?: boolean;
}

/** JSON-only categories the markdown exporter never emits. */
const UNAVAILABLE_CATEGORIES = ["duplicate", "layer-violation", "suggestion"];

/** `status` is the HTTP status for a failed fetch, or null for a thrown failure. */
export type ReportOutcome =
	{ ok: true; result: ReportResult } | { ok: false; message: string; status: number | null };

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type WriteFileFn = (path: string, data: Uint8Array) => void;

const defaultFetch: FetchFn = (url, init) => fetch(url, init);

/**
 * `O_CREAT|O_EXCL`: fail rather than open an existing path (so a pre-planted
 * symlink at the temp path can never be followed). `O_NOFOLLOW` is belt and
 * braces for the same component.
 */
const EXCLUSIVE_WRITE_FLAGS =
	constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

const defaultWriteFile: WriteFileFn = (path, data) => {
	const fd = openSync(path, EXCLUSIVE_WRITE_FLAGS, 0o600);
	try {
		for (let offset = 0; offset < data.length;) {
			const n = writeSync(fd, data, offset, data.length - offset);
			if (n <= 0) throw new Error(`Short write to ${path} (${offset}/${data.length} bytes)`);
			offset += n;
		}
	} finally {
		closeSync(fd);
	}
};

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

/** Decode report bytes as UTF-8 for content classification. */
function decodeBody(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/**
 * Markdown narration for a JSON-only recovery: a pre-#1976 shim serves the
 * structured export on the markdown route, so there is no markdown report to
 * persist. `path` must still point at a readable markdown file (Step 1 of the
 * skill reads it), so write a short placeholder that redirects the reader to
 * the authoritative JSON artifact instead of leaving `path` dangling.
 */
function renderRecoveredMarkdown(analyzedAt: number | null): Uint8Array {
	const when = analyzedAt === null ? "unknown" : new Date(analyzedAt).toISOString();
	return new TextEncoder().encode(
		"# CodeFlow Analysis Report\n\n" +
			"> **JSON-only recovery.** This shim's markdown route served the structured JSON " +
			"export and no markdown narration is available, so this file is narration only. " +
			"The authoritative findings are in `" + REPORT_JSON_REL_PATH + "`.\n\n" +
			`- Analysis timestamp: ${when}\n`,
	);
}

/**
 * Fail closed when the on-disk parent directory resolves (through symlinks)
 * outside `cwd`. The lexical `resolveWithinRoot` check runs first, but a
 * symlinked `ignore` directory defeats it — this resolves the real path after
 * the directory exists on disk.
 */
function assertRealDirWithinRoot(cwd: string, dir: string): void {
	if (!isPathWithinBase(realpathSync(dir), realpathSync(cwd))) {
		throw new Error(
			`Refusing to write report: "${dir}" resolves outside the project root (symlink escape).`,
		);
	}
}

/**
 * Write bytes via a uniquely-named temp file + rename. The temp name is
 * randomized so it can never be pre-planted, and it is created exclusively with
 * no-follow semantics (see `EXCLUSIVE_WRITE_FLAGS`); the parent directory is
 * verified against the real workspace path after creation. The temp is removed
 * on failure so a crashed write never leaves `*.tmp` next to the report.
 */
function writeAtomically(cwd: string, target: string, data: Uint8Array): void {
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	assertRealDirWithinRoot(cwd, dir);
	const tmp = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileFn(tmp, data);
		renameSync(tmp, target);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// best-effort cleanup; the original error is what matters
		}
		throw err;
	}
}

/**
 * Delete an artifact a previous fetch left behind, refusing to reach outside
 * `cwd` through a symlinked parent. Returns true when a file was removed.
 *
 * A refresh that finds no JSON must not leave the earlier analysis's JSON
 * artifact on disk: `dry-run.mts` auto-loads that default path, so a stale file
 * makes a partial run look complete.
 */
function removeStaleArtifact(cwd: string, target: string): boolean {
	const dir = dirname(target);
	if (!existsSync(dir) || !existsSync(target)) return false;
	assertRealDirWithinRoot(cwd, dir);
	rmSync(target, { force: true });
	return true;
}

/** GET a report route; returns the response or throws on transport failure. */
async function getReport(url: string, signal?: AbortSignal): Promise<Response> {
	try {
		return await fetchFn(url, { method: "GET", signal });
	} catch (err) {
		// A cancelled request stays in the abort channel.
		signal?.throwIfAborted();
		throw new Error(
			`CodeFlow request failed (${url}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** The shim's per-route bridge telemetry, or null when the route is absent. */
async function fetchBridgeStatus(
	base: string,
	signal?: AbortSignal,
): Promise<Record<string, Record<string, unknown>> | null> {
	try {
		const resp = await fetchFn(`${base}/api/analysis/bridge-status`, { method: "GET", signal });
		if (!resp.ok) return null;
		const data: unknown = await resp.json();
		if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
		return data as Record<string, Record<string, unknown>>;
	} catch {
		// A cancelled status probe stays in the abort channel so a caller awaiting
		// the report sees the abort rather than a successful result.
		signal?.throwIfAborted();
		return null;
	}
}

/**
 * Explain a 404 on the JSON route: the bridge telemetry distinguishes a
 * capture-side gap (the export never reached the shim) from a route fault
 * (the shim received the POST but does not serve it). Without telemetry the
 * cause is unknowable and the warning says so rather than guessing.
 */
async function jsonUnavailableWarning(base: string, signal?: AbortSignal): Promise<string> {
	const tail = "duplicates, layer violations and suggestions cannot be extracted.";
	const status = await fetchBridgeStatus(base, signal);
	const json = status?.["/api/analysis/report.json"];
	if (json && typeof json === "object") {
		const postedAt = json.postedAt ?? null;
		if (postedAt !== null) {
			return (
				`Structured JSON report route is down (GET HTTP 404) although the shim received the JSON export ` +
				`(bridge-status json.postedAt set, httpStatus ${json.httpStatus ?? "unknown"}); ${tail}`
			);
		}
		return (
			`Structured JSON report was never POSTed by the browser bridge ` +
			`(bridge-status json.capturedAt ${json.capturedAt ?? "null"}, postedAt null) — a capture-side gap; ${tail}`
		);
	}
	return (
		`Structured JSON report unavailable (HTTP 404) and bridge-status is unreachable, ` +
		`so the capture-versus-route cause cannot be determined; ${tail}`
	);
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

	const resp = await getReport(url, opts.signal);
	opts.signal?.throwIfAborted();

	if (resp.status === 404) {
		const actionable = (): ReportOutcome => ({
			ok: false,
			status: 404,
			message:
				`No CodeFlow report yet — run analysis in CodeFlow (${base}) and wait for it to finish, ` +
				`then run the fetch script again.`,
		});
		// The report slot is empty. Ask the sidecar to fill it headlessly; only an
		// old shim with no run route keeps the manual actionable 404.
		if (opts.runOnMissing === false) return actionable();
		const run = await ensureReport({ signal: opts.signal, fetchFn, base });
		opts.signal?.throwIfAborted();
		if (run.ok) {
			return fetchAndStoreReport({ ...opts, refresh: true, runOnMissing: false });
		}
		if (run.kind === "run-route-absent") return actionable();
		// A failed/timed-out/unavailable run is not "no browser run" — surface the
		// reason with a null status so the CLI maps it to a transport failure.
		return { ok: false, status: null, message: run.message };
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

	const warnings: string[] = [];
	// Defense-in-depth: an old bridge or a manual POST can land a JSON body on
	// the markdown route. Classify *before* persisting so a recovered JSON body
	// is recovered into the structured artifact and never written as the
	// markdown artifact (the shim's own routing is fixed in `_BRIDGE_JS.capture`;
	// this bridges the gap only, and says so loudly).
	const recoveredFromMarkdownRoute = classifyReportBody(decodeBody(bytes)) === "json";
	let jsonBytes: Uint8Array | null = recoveredFromMarkdownRoute ? bytes : null;
	// Byte count of the markdown artifact actually written to `path`.
	let markdownBytes: Uint8Array = bytes;
	if (recoveredFromMarkdownRoute) {
		warnings.push(
			"The markdown route returned a JSON export body (the browser bridge misrouted " +
				"generateReport('json')); it was recovered as the structured artifact. This shim " +
				"serves no markdown narration, so a placeholder markdown file was written to the " +
				"markdown path.",
		);
		// The JSON body must never sit at the markdown path, but `path` must stay a
		// readable markdown file (Step 1 reads it), so overwrite it with narration.
		markdownBytes = renderRecoveredMarkdown(analyzedAt);
		writeAtomically(opts.cwd, target, markdownBytes);
	} else {
		writeAtomically(opts.cwd, target, bytes);
	}

	try {
		const jsonResp = await getReport(`${base}/api/analysis/report.json`, opts.signal);
		if (jsonResp.ok) {
			const body = new Uint8Array(await jsonResp.arrayBuffer());
			if (classifyReportBody(decodeBody(body)) === "json") {
				jsonBytes = body;
			} else {
				warnings.push(
					"Structured JSON report route returned a body that is neither the JSON export " +
						"nor markdown; it was not stored as the structured artifact.",
				);
			}
		} else if (jsonResp.status === 404) {
			if (jsonBytes === null) warnings.push(await jsonUnavailableWarning(base, opts.signal));
		} else if (jsonBytes === null) {
			warnings.push(
				`Structured JSON report unavailable (HTTP ${jsonResp.status}); duplicates, layer violations and suggestions cannot be extracted.`,
			);
		}
	} catch (err) {
		opts.signal?.throwIfAborted();
		if (jsonBytes === null) {
			warnings.push(
				`Structured JSON report fetch failed: ${err instanceof Error ? err.message : String(err)}; duplicates, layer violations and suggestions cannot be extracted.`,
			);
		}
	}

	let jsonPath: string | null = null;
	const jsonTarget = resolveWithinRoot(opts.cwd, REPORT_JSON_REL_PATH);
	if (jsonBytes !== null) {
		writeAtomically(opts.cwd, jsonTarget, jsonBytes);
		jsonPath = jsonTarget;
	} else if (removeStaleArtifact(opts.cwd, jsonTarget)) {
		warnings.push(
			"Removed a stale structured JSON artifact left by an earlier analysis, so it cannot be mistaken for this report's JSON.",
		);
	}

	const partial = jsonPath === null;
	// A JSON-less run must name the categories it cannot see; a warning already
	// carrying the list (from `jsonUnavailableWarning`) is enough.
	if (partial && !warnings.some((w) => w.includes("duplicates, layer violations and suggestions"))) {
		warnings.push(
			`Structured JSON report unavailable, so ${UNAVAILABLE_CATEGORIES.join(", ")} categories cannot be extracted.`,
		);
	}

	const result: ReportResult = {
		path: target,
		jsonPath,
		bytes: markdownBytes.length,
		analyzedAt,
		warnings,
		partial,
		unavailableCategories: partial ? [...UNAVAILABLE_CATEGORIES] : [],
		recoveredFromMarkdownRoute,
	};
	cache = result;
	cacheCwd = opts.cwd;
	return { ok: true, result };
}
