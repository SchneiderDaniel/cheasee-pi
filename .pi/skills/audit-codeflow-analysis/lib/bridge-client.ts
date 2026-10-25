// ─── CodeFlow bridge HTTP client ────────────────────────────────
// Transport for the compose-internal shim's report routes, including the
// bridge telemetry that explains a 404. Split out of fetch-report.ts (issue
// #2033): HTTP stays here, filesystem in report-store.ts, policy in the use
// case. The fetch client is injected so tests swap it per call.

import type { FetchFn } from "./report-types.ts";

/** GET a report route; returns the response or throws on transport failure. */
export async function getReport(
	fetchFn: FetchFn,
	url: string,
	signal?: AbortSignal,
): Promise<Response> {
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
export async function fetchBridgeStatus(
	fetchFn: FetchFn,
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
export async function jsonUnavailableWarning(
	fetchFn: FetchFn,
	base: string,
	signal?: AbortSignal,
): Promise<string> {
	const tail = "duplicates, layer violations and suggestions cannot be extracted.";
	const status = await fetchBridgeStatus(fetchFn, base, signal);
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
