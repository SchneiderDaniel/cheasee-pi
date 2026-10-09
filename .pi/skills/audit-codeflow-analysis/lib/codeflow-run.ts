/**
 * CodeFlow headless-run use case — trigger the shim's on-demand run, poll its
 * status to a terminal state, and decode the outcome.
 *
 * `lib/fetch-report.ts` owns artifact persistence; this module owns run policy
 * (single POST, bounded polling, timeout, failure mapping) and is free of I/O
 * itself: the HTTP client, the sleep timer and the clock are injected so tests
 * are instant and deterministic. A run route that is absent (older shim) is
 * reported as a sentinel so the transport can keep its actionable 404.
 *
 * `status` is never inferable from HTTP 202 alone (RFC 9110: 202 means
 * "accepted", not "done"), so the caller must poll `run-status` until the run
 * reaches `succeeded` or `failed`.
 */

import { codeflowServiceUrl } from "../../../extensions/lib/codeflow-endpoint.ts";

/** Client-side ceiling on a run; the shim's own `run_timeout_s` fires first. */
const DEFAULT_RUN_TIMEOUT_MS = 1_020_000;
/** Delay between status polls — the analysis takes minutes, so this is coarse. */
const RUN_POLL_INTERVAL_MS = 3000;

export type RunFetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;
type NowFn = () => number;

export interface RunStatus {
	runId: string | null;
	state: string;
	startedAt: number | null;
	finishedAt: number | null;
	reason: string | null;
	error: string | null;
	reportAt: number | null;
	produced: { markdown: boolean; json: boolean };
}

/**
 * `ok` → the report slots are filled; `kind` distinguishes why a run did not
 * produce a report:
 *   run-route-absent     — old shim; the caller keeps its actionable 404
 *   analyzer-unavailable — the image carries no analyzer (HTTP 503)
 *   run-failed           — the run reached a terminal failure state
 *   timeout              — no terminal state within the client budget
 */
export type EnsureReportResult =
	| { ok: true; reportAt: number | null }
	| { ok: false; kind: "run-route-absent" }
	| { ok: false; kind: "analyzer-unavailable"; message: string }
	| { ok: false; kind: "run-failed"; message: string }
	| { ok: false; kind: "timeout"; message: string };

export interface EnsureReportOptions {
	signal?: AbortSignal;
	/** Override the service base (tests); defaults to `codeflowServiceUrl()`. */
	base?: string;
	fetchFn?: RunFetchFn;
	sleepFn?: SleepFn;
	nowFn?: NowFn;
	timeoutMs?: number;
	pollIntervalMs?: number;
}

const defaultFetch: RunFetchFn = (url, init) => fetch(url, init);

const defaultSleep: SleepFn = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("CodeFlow run polling aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new Error("CodeFlow run polling aborted"));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/** Thrown when a request exceeds the remaining client budget. */
class RequestTimeoutError extends Error {
	constructor() {
		super("CodeFlow request exceeded the client timeout");
		this.name = "RequestTimeoutError";
	}
}

/** Decode a `/api/analysis/run-status` body; null when the shape is unusable. */
export function parseRunStatus(data: unknown): RunStatus | null {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
	const o = data as Record<string, unknown>;
	const produced = o.produced;
	if (produced === null || typeof produced !== "object" || Array.isArray(produced)) return null;
	const p = produced as Record<string, unknown>;
	if (typeof o.state !== "string") return null;
	if (typeof p.markdown !== "boolean") return null;
	const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
	const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
	return {
		runId: str(o.runId),
		state: o.state,
		startedAt: num(o.startedAt),
		finishedAt: num(o.finishedAt),
		reason: str(o.reason),
		error: str(o.error),
		reportAt: num(o.reportAt),
		produced: { markdown: p.markdown, json: p.json === true },
	};
}

async function readReason(resp: Response): Promise<string | null> {
	try {
		const data: unknown = await resp.json();
		if (data && typeof data === "object" && !Array.isArray(data)) {
			const reason = (data as Record<string, unknown>).reason;
			if (typeof reason === "string" && reason !== "") return reason;
		}
	} catch {
		// non-JSON body — the HTTP status is the message
	}
	return null;
}

function runFailureMessage(status: RunStatus): string {
	const reason = status.reason ?? "unknown";
	const detail = status.error ? `: ${status.error}` : "";
	return `CodeFlow headless run failed (${reason})${detail}`;
}

/**
 * Trigger a headless run when needed and wait for it to fill the report slots.
 * Never throws for run outcomes (only for an aborted signal); the caller maps
 * `ok:false` to a user-visible message.
 *
 * The client budget starts before the trigger request and bounds *every*
 * request: a stalled trigger or status response must not outlive the deadline,
 * or the CLI would wait forever on a wedged shim.
 */
export async function ensureReport(opts: EnsureReportOptions = {}): Promise<EnsureReportResult> {
	const base = opts.base ?? codeflowServiceUrl();
	const fetchFn = opts.fetchFn ?? defaultFetch;
	const sleep = opts.sleepFn ?? defaultSleep;
	const now = opts.nowFn ?? Date.now;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const interval = opts.pollIntervalMs ?? RUN_POLL_INTERVAL_MS;
	const deadline = now() + timeoutMs;

	const timedOut = (): EnsureReportResult => ({
		ok: false,
		kind: "timeout",
		message: `CodeFlow run did not finish within ${Math.round(timeoutMs / 1000)}s.`,
	});

	// One request, bounded by the caller signal and the remaining client budget;
	// `consume` runs inside that bound, so a stalled response body cannot outlive
	// the deadline either. A caller abort rethrows through `throwIfAborted`; only
	// a budget expiry maps to a timeout result.
	const doFetch = async <T>(
		url: string,
		init: RequestInit,
		consume: (resp: Response) => Promise<T>,
	): Promise<T> => {
		opts.signal?.throwIfAborted();
		const remaining = deadline - now();
		if (remaining <= 0) throw new RequestTimeoutError();
		const ctrl = new AbortController();
		let fired = false;
		const onAbort = (): void => ctrl.abort(opts.signal?.reason ?? new Error("aborted"));
		if (opts.signal?.aborted) onAbort();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			fired = true;
			ctrl.abort(new Error("client timeout"));
		}, remaining);
		try {
			return await consume(await fetchFn(url, { ...init, signal: ctrl.signal }));
		} catch (err) {
			opts.signal?.throwIfAborted();
			if (fired) throw new RequestTimeoutError();
			throw err;
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		}
	};

	let trigger: { status: number; reason: string | null };
	try {
		trigger = await doFetch(`${base}/api/analysis/run`, { method: "POST" }, async (resp) => ({
			status: resp.status,
			reason: resp.status === 503 ? await readReason(resp) : null,
		}));
	} catch (err) {
		if (err instanceof RequestTimeoutError) return timedOut();
		throw err;
	}
	opts.signal?.throwIfAborted();

	if (trigger.status === 404) return { ok: false, kind: "run-route-absent" };
	if (trigger.status === 503) {
		return {
			ok: false,
			kind: "analyzer-unavailable",
			message:
				`CodeFlow headless analyzer is unavailable (HTTP 503${trigger.reason ? `: ${trigger.reason}` : ""}); ` +
				"the codeflow image must ship Node and run-analysis.mjs.",
		};
	}
	// 202 accepted, 409 already running — both mean "poll the existing run".
	if (trigger.status !== 202 && trigger.status !== 409) {
		return {
			ok: false,
			kind: "run-failed",
			message: `CodeFlow run trigger failed: HTTP ${trigger.status}`,
		};
	}

	for (;;) {
		opts.signal?.throwIfAborted();
		if (now() >= deadline) return timedOut();
		let result: { ok: boolean; status: number; run: RunStatus | null };
		try {
			result = await doFetch(`${base}/api/analysis/run-status`, { method: "GET" }, async (resp) => {
				if (!resp.ok) return { ok: false, status: resp.status, run: null };
				return { ok: true, status: resp.status, run: parseRunStatus(await resp.json()) };
			});
		} catch (err) {
			if (err instanceof RequestTimeoutError) return timedOut();
			throw err;
		}
		opts.signal?.throwIfAborted();
		if (!result.ok) {
			return {
				ok: false,
				kind: "run-failed",
				message: `CodeFlow run status fetch failed: HTTP ${result.status}`,
			};
		}
		const status = result.run;
		if (status === null) {
			return {
				ok: false,
				kind: "run-failed",
				message: "CodeFlow run status is malformed; refusing to poll indefinitely.",
			};
		}
		if (status.state === "succeeded") {
			if (!status.produced.markdown) {
				return {
					ok: false,
					kind: "run-failed",
					message: "CodeFlow run succeeded but produced no markdown report.",
				};
			}
			return { ok: true, reportAt: status.reportAt };
		}
		if (status.state === "failed") {
			return { ok: false, kind: "run-failed", message: runFailureMessage(status) };
		}
		if (status.state !== "running" && status.state !== "idle") {
			return {
				ok: false,
				kind: "run-failed",
				message: `CodeFlow run reported an unknown state ${JSON.stringify(status.state)}.`,
			};
		}
		if (now() >= deadline) return timedOut();
		await sleep(Math.min(interval, Math.max(0, deadline - now())), opts.signal);
	}
}
