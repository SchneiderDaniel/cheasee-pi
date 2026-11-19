// ─── Pull-request ports and result shapes (shared) ──────────────
// The structural ports `shared/github/` needs, kept apart from the create
// sequence so both the Supervisor's GitHubPort and the goal-loop adapter can
// satisfy them without importing either extension.

/** The PR operations this module needs. Supervisor's GitHubPort satisfies it. */
export interface PrPortLike {
	listPullRequestsForBranch(branch: string, repo: string): Promise<{ number: number } | null>;
	createPullRequest(input: {
		repo: string;
		base: string;
		head: string;
		title: string;
		body?: string;
	}): Promise<{ number: number }>;
	updatePullRequest(prNumber: number, repo: string, body: string, title?: string): Promise<void>;
}

/** Level-carrying notify hook (same shape Supervisor's pr-creation passes). */
export type PrNotify = (message: string, level: "info" | "warning" | "error") => void;

/** Minimal debug-logger port; Supervisor passes its DebugLogger unchanged. */
export interface PrLogger {
	info(context: string, message: string): void;
	warn(context: string, message: string): void;
	error(context: string, message: string): void;
}

/** Outcome of one create-or-update attempt. */
export interface PrUpsertResult {
	success: boolean;
	prNumber?: number;
	error?: string;
	wasUpdate?: boolean;
	source?: string;
}

/** Logger context shared by both modules. */
export const LOG_CONTEXT = "pr-creation";

/** Maximum number of create attempts (transient API failures, rate limits). */
export const MAX_PR_CREATE_RETRIES = 2;

/** Base delay (ms) for exponential backoff retry. */
export const RETRY_BASE_DELAY_MS = 1000;
