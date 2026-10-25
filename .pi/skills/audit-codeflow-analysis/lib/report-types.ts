// ─── Report transport types ─────────────────────────────────────
// The injection seams (`FetchFn`, `WriteFileFn`) and the outcome shapes the
// use case returns. Split out of fetch-report.ts (issue #2033) so the HTTP
// client and the artifact store depend on the types without a cycle.

export interface ReportResult {
	path: string;
	jsonPath: string | null;
	bytes: number;
	analyzedAt: number | null;
	warnings: string[];
	/** True when no *usable* structured JSON artifact was stored; the run cannot see the JSON-only categories. */
	partial: boolean;
	/** Categories the markdown exporter never emits, empty when a usable JSON artifact was stored. */
	unavailableCategories: string[];
	/** True when a misrouted JSON body was recovered from the markdown route. */
	recoveredFromMarkdownRoute?: boolean;
}

/** `status` is the HTTP status for a failed fetch, or null for a thrown failure. */
export type ReportOutcome =
	{ ok: true; result: ReportResult } | { ok: false; message: string; status: number | null };

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type WriteFileFn = (path: string, data: Uint8Array) => void;
