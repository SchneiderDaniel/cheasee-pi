// ─── Empty report slot ──────────────────────────────────────────
// What to do when the markdown route has no report yet: ask the sidecar to run
// the analysis headlessly, and only keep the manual 404 when the shim has no
// run route or the run failed. Split out of fetch-report.ts (issue #2033).

import { ensureReport } from "./codeflow-run.ts";
import type { FetchFn, ReportOutcome } from "./report-types.ts";

/** The markdown-route 404: no browser analysis has been bridged yet. */
export function noReportOutcome(base: string): ReportOutcome {
	return {
		ok: false,
		status: 404,
		message:
			`No CodeFlow report yet — run analysis in CodeFlow (${base}) and wait for it to finish, ` +
			`then run the fetch script again.`,
	};
}

export type MissingReportResolution = { retry: true } | { retry: false; outcome: ReportOutcome };

/**
 * Resolve an empty report slot. `{ retry: true }` means a headless run just
 * completed and the caller should re-fetch; otherwise the outcome is final.
 */
export async function resolveMissingReport(
	fetchFn: FetchFn,
	base: string,
	signal: AbortSignal | undefined,
	runOnMissing: boolean | undefined,
): Promise<MissingReportResolution> {
	if (runOnMissing === false) return { retry: false, outcome: noReportOutcome(base) };
	const run = await ensureReport({ signal, fetchFn, base });
	signal?.throwIfAborted();
	if (run.ok) return { retry: true };
	if (run.kind === "run-route-absent") return { retry: false, outcome: noReportOutcome(base) };
	// A failed/timed-out/unavailable run is not "no browser run" — surface the
	// reason with a null status so the CLI maps it to a transport failure.
	return { retry: false, outcome: { ok: false, status: null, message: run.message } };
}
