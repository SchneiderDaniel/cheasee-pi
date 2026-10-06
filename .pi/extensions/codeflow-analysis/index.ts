/**
 * codeflow_analysis_report — fetch the CodeFlow markdown analysis from the
 * compose-internal codeflow shim and save it as a local artifact.
 *
 * Transport only: resolve the endpoint, GET /api/analysis/report, write the
 * bytes atomically to `ignore/codeflow-report.md`. Interpretation (parsing,
 * file-conflict grouping, issue filing) is owned by the codeflow-analysis
 * skill, which reads the artifact this tool produces.
 *
 * Test seams (module-scoped, reset in tests):
 *   setFetchFactory      — swap the HTTP client
 *   setWriteFileFactory  — inject a write failure
 *   resetReportCache     — clear the session cache
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codeflowServiceUrl } from "../lib/codeflow-endpoint.ts";
import { resolveWithinRoot } from "../lib/path-containment.ts";

/** Artifact path, relative to the session cwd (gitignored). */
export const REPORT_REL_PATH = "ignore/codeflow-report.md";

interface ReportResult {
	path: string;
	bytes: number;
	analyzedAt: number | null;
}

export type ReportOutcome = { ok: true; result: ReportResult } | { ok: false; message: string };

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type WriteFileFn = (path: string, data: Uint8Array) => void;

const defaultFetch: FetchFn = (url, init) => fetch(url, init);
const defaultWriteFile: WriteFileFn = (path, data) => writeFileSync(path, data);

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
 * Write bytes via a temp file + rename, removing the temp on failure so a
 * crashed write never leaves `*.tmp` next to the report.
 */
function writeAtomically(target: string, data: Uint8Array): void {
	const tmp = `${target}.tmp`;
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
 * Fetch the report and persist it. HTTP-level failures come back as
 * `{ ok: false }` (a missing report is an actionable state, not a crash);
 * transport failures and aborts throw.
 */
export async function fetchAndStoreReport(opts: {
	cwd: string;
	refresh?: boolean;
	signal?: AbortSignal;
}): Promise<ReportOutcome> {
	if (!opts.refresh && cache && cacheCwd === opts.cwd) return { ok: true, result: cache };

	const base = codeflowServiceUrl();
	const url = `${base}/api/analysis/report`;

	let resp: Response;
	try {
		resp = await fetchFn(url, { method: "GET", signal: opts.signal });
	} catch (err) {
		// A cancelled request stays in the abort channel.
		opts.signal?.throwIfAborted();
		throw new Error(
			`CodeFlow request failed (${url}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	opts.signal?.throwIfAborted();

	if (resp.status === 404) {
		return {
			ok: false,
			message:
				`No CodeFlow report yet — run analysis in CodeFlow (${base}) and wait for it to finish, ` +
				`then call codeflow_analysis_report again.`,
		};
	}
	if (!resp.ok) {
		return { ok: false, message: `CodeFlow report fetch failed: HTTP ${resp.status} from ${url}` };
	}

	const bytes = new Uint8Array(await resp.arrayBuffer());
	const analyzedAt = parseAnalyzedAt(resp.headers.get("X-Codeflow-Analysis-At"));

	const target = resolveWithinRoot(opts.cwd, REPORT_REL_PATH);
	mkdirSync(dirname(target), { recursive: true });
	writeAtomically(target, bytes);

	const result: ReportResult = { path: target, bytes: bytes.length, analyzedAt };
	cache = result;
	cacheCwd = opts.cwd;
	return { ok: true, result };
}

export default function codeflowAnalysis(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "codeflow_analysis_report",
		label: "CodeFlow Analysis Report",
		description:
			"Fetch the CodeFlow structural analysis (markdown) from the local codeflow container and save it " +
			`to ${REPORT_REL_PATH}. Returns {path, bytes, analyzedAt}. 404 means no analysis has run in the ` +
			"browser yet — run one in CodeFlow first.",
		promptSnippet: "Fetch the CodeFlow markdown analysis report and save it locally",
		promptGuidelines: [
			"Use codeflow_analysis_report to pull the browser-run CodeFlow analysis into the workspace before parsing it with the codeflow-analysis skill.",
			"If it reports that no report exists yet, ask the user to run an analysis in the CodeFlow UI, then retry (pass refresh: true to re-fetch).",
		],
		parameters: Type.Object({
			refresh: Type.Optional(
				Type.Boolean({ description: "Bypass the session cache and re-fetch the report." }),
			),
		}),
		annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const outcome = await fetchAndStoreReport({ cwd: ctx.cwd, refresh: params.refresh, signal });
			if (!outcome.ok) {
				return {
					content: [{ type: "text" as const, text: outcome.message }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}
			const { path, bytes, analyzedAt } = outcome.result;
			const when = analyzedAt === null ? "" : `, analyzed at ${new Date(analyzedAt).toISOString()}`;
			return {
				content: [
					{
						type: "text" as const,
						text: `Saved CodeFlow report (${bytes} bytes) to ${path}${when}.`,
					},
				],
				details: outcome.result as unknown as Record<string, unknown>,
			};
		},
	});

	pi.on("session_shutdown", () => {
		resetReportCache();
	});
}
