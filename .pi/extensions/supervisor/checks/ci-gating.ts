// ─── CI Gating ──────────────────────────────────────────────────────
// Polls GitHub check runs before dispatching the auditor. The gate is
// PR-aware: it resolves the open pull request's head SHA (not
// `origin/<branch>`) and classifies that commit's check runs. Blocking
// policy lives in pipeline/audit/pre-gates.ts — this module only reports
// facts (passing / failing / pending / error / unconfigured).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CiCheckInfo {
	id?: number;
	name: string;
	status: string;
	conclusion: string | null;
}

export interface CiPollResult {
	status: "passing" | "failing" | "pending" | "error" | "unconfigured";
	checks: CiCheckInfo[];
	/** Names of the check runs that blocked the gate — only set when failing. */
	failingChecks: string[];
	message: string;
}

/** Injected seams so tests never touch real timers. */
export interface PollCiChecksOptions {
	sleepFn?: (ms: number) => Promise<void>;
	nowFn?: () => number;
	/** How long zero check runs must persist before reporting `unconfigured`. */
	unconfiguredGraceMs?: number;
	pollIntervalMs?: number;
	/**
	 * The commit the gate expects to evaluate — normally the SHA the developer
	 * just pushed (issue #1829). When set, a resolved PR head that differs makes
	 * the poll `pending` naming both SHAs: the pushed commit's checks have not
	 * been created yet, and classifying the stale head could pass a red push.
	 * Omit it for the legacy behaviour of classifying whatever the PR head is.
	 */
	expectedHeadSha?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 15_000;
/** Guard against a non-advancing injected clock (never reached in production). */
const MAX_POLLS = 10_000;

/** Conclusions that make the gate red (AC3). */
const FAILURE_CONCLUSIONS = new Set([
	"failure",
	"cancelled",
	"action_required",
	"timed_out",
	"stale",
]);
/** Conclusions that tolerate a completed check as non-blocking (AC2). */
const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/**
 * Pure classification of check runs (AC2/AC3/AC4).
 *
 * - no check runs            → `unconfigured`
 * - any failure conclusion   → `failing` (short-circuits pending checks)
 * - all completed + tolerated → `passing`
 * - anything else            → `pending` (unknown conclusions never pass)
 */
export function classifyCheckRuns(checks: CiCheckInfo[]): {
	status: CiPollResult["status"];
	failingChecks: string[];
} {
	if (checks.length === 0) {
		return { status: "unconfigured", failingChecks: [] };
	}

	const failingChecks: string[] = [];
	for (const check of checks) {
		if (!check.conclusion || !FAILURE_CONCLUSIONS.has(check.conclusion)) continue;
		if (!failingChecks.includes(check.name)) failingChecks.push(check.name);
	}
	if (failingChecks.length > 0) {
		return { status: "failing", failingChecks };
	}

	const allPassing = checks.every(
		(check) =>
			check.status === "completed" &&
			check.conclusion !== null &&
			PASSING_CONCLUSIONS.has(check.conclusion),
	);
	return { status: allPassing ? "passing" : "pending", failingChecks: [] };
}

/**
 * Poll the check runs of the open pull request's head commit.
 *
 * Resolves the PR head SHA for `branch` first (a missing PR is an `error`,
 * never a silent pass). Then polls `gh api --paginate .../check-runs` every
 * `pollIntervalMs` until the checks are terminal, the gate deadline
 * (`timeoutSec`) is reached, or the unconfigured grace window expires.
 *
 * Edge cases:
 * - No open PR / unparseable PR response → `error` (fail-closed)
 * - Zero check runs persisting past the grace window → `unconfigured` (AC4)
 * - Unparseable check-run line → `error` (never drop a line and pass a red PR)
 * - Checks still in progress at the deadline → `pending`
 * - `gh`/network failure → `error`
 */
export async function pollCiChecks(
	pi: ExtensionAPI,
	branch: string,
	repo: string,
	timeoutSec: number,
	opts: PollCiChecksOptions = {},
): Promise<CiPollResult> {
	const sleepFn = opts.sleepFn ?? sleep;
	const nowFn = opts.nowFn ?? Date.now;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const unconfiguredGraceMs = opts.unconfiguredGraceMs ?? 60_000;
	const expectedHeadSha = opts.expectedHeadSha;

	// An explicitly empty expectation is a caller defect: failing closed here is
	// the only safe answer — a poll with no pinned commit cannot prove anything
	// about the push the gate is guarding (issue #1829).
	if (expectedHeadSha !== undefined && expectedHeadSha.trim().length === 0) {
		return {
			status: "error",
			checks: [],
			failingChecks: [],
			message:
				"CI gate has no expected head SHA to verify — refusing to classify check runs.",
		};
	}

	const head = await resolvePullRequestHeadSha(pi, branch, repo);
	if (!head.ok) {
		return { status: "error", checks: [], failingChecks: [], message: head.message };
	}

	// A head that moved past the expected commit means the pushed commit's check
	// runs do not exist yet (or the PR was updated by someone else). Report
	// pending instead of classifying another commit's checks (issue #1829 AC4).
	if (expectedHeadSha !== undefined && head.sha !== expectedHeadSha) {
		return {
			status: "pending",
			checks: [],
			failingChecks: [],
			message: `PR head ${head.sha} does not match the pushed commit ${expectedHeadSha}; CI has not run on the pushed commit yet.`,
		};
	}

	const deadline = nowFn() + Math.max(0, timeoutSec) * 1000;
	let lastChecks: CiCheckInfo[] = [];
	let emptySinceMs: number | null = null;

	for (let polls = 0; polls < MAX_POLLS; polls++) {
		const pollStartMs = nowFn();

		let checks: CiCheckInfo[];
		try {
			checks = await fetchCheckRuns(pi, repo, head.sha);
		} catch (err: unknown) {
			return {
				status: "error",
				checks: lastChecks,
				failingChecks: [],
				message: `CI check polling failed for ${head.sha}: ${errorMessage(err)}.`,
			};
		}
		lastChecks = checks;

		const classification = classifyCheckRuns(checks);

		if (classification.status === "passing") {
			return {
				status: "passing",
				checks,
				failingChecks: [],
				message: `All ${checks.length} CI check(s) completed successfully.`,
			};
		}
		if (classification.status === "failing") {
			return {
				status: "failing",
				checks,
				failingChecks: classification.failingChecks,
				message: `CI checks failing: ${classification.failingChecks.join(", ")}.`,
			};
		}
		if (classification.status === "unconfigured") {
			if (emptySinceMs === null) emptySinceMs = pollStartMs;
			if (pollStartMs - emptySinceMs >= unconfiguredGraceMs) {
				return unconfiguredResult(head.sha);
			}
		} else {
			// Checks exist but are not terminal yet — the grace window is irrelevant.
			emptySinceMs = null;
		}

		if (nowFn() >= deadline) {
			// A repo without CI must not hang (AC4) — report unconfigured at the deadline.
			if (emptySinceMs !== null) return unconfiguredResult(head.sha);
			const pendingNames = checks
				.filter(
					(check) =>
						!(check.conclusion !== null && PASSING_CONCLUSIONS.has(check.conclusion)) ||
						check.status !== "completed",
				)
				.map((check) => check.name);
			return {
				status: "pending",
				checks,
				failingChecks: [],
				message: `CI checks still pending after ${timeoutSec}s timeout: ${pendingNames.join(", ") || "unknown"}.`,
			};
		}

		await sleepFn(pollIntervalMs);
	}

	return {
		status: "error",
		checks: lastChecks,
		failingChecks: [],
		message: `CI polling exceeded ${MAX_POLLS} polls; the clock did not advance.`,
	};
}

function unconfiguredResult(sha: string): CiPollResult {
	return {
		status: "unconfigured",
		checks: [],
		failingChecks: [],
		message: `No CI checks configured for this repo (no check runs on ${sha}). Proceeding without CI gating.`,
	};
}

/**
 * Resolve the head SHA of the open pull request whose head is `branch`.
 * Returns a failure message instead of throwing so the caller can fail closed.
 */
async function resolvePullRequestHeadSha(
	pi: ExtensionAPI,
	branch: string,
	repo: string,
): Promise<{ ok: true; sha: string } | { ok: false; message: string }> {
	const owner = repo.split("/")[0] ?? "";
	const path = `repos/${repo}/pulls?head=${owner}:${branch}&state=open&per_page=1`;

	let stdout: string;
	try {
		const result = await pi.exec("gh", ["api", path], { timeout: 15_000 });
		if (result.code !== 0) {
			return {
				ok: false,
				message: `Could not look up the pull request for branch '${branch}': ${(result.stderr || "").trim() || `gh exited with code ${result.code}`}.`,
			};
		}
		stdout = (result.stdout || "").trim();
	} catch (err: unknown) {
		return {
			ok: false,
			message: `Could not look up the pull request for branch '${branch}': ${errorMessage(err)}.`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return {
			ok: false,
			message: `Could not parse the pull request response for branch '${branch}'.`,
		};
	}
	if (!Array.isArray(parsed)) {
		return {
			ok: false,
			message: `Unexpected pull request response for branch '${branch}' (expected a JSON array).`,
		};
	}
	if (parsed.length === 0) {
		return {
			ok: false,
			message: `No open pull request found for branch '${branch}'. CI gating requires a PR head SHA.`,
		};
	}

	const sha = (parsed[0] as { head?: { sha?: unknown } } | null)?.head?.sha;
	if (typeof sha !== "string" || sha.length === 0) {
		return {
			ok: false,
			message: `Open pull request for branch '${branch}' has no head SHA.`,
		};
	}
	return { ok: true, sha };
}

/**
 * Fetch and parse every check run of `sha`. Throws on `gh` failure or on an
 * unparseable line — a silent drop could pass a red PR.
 */
async function fetchCheckRuns(pi: ExtensionAPI, repo: string, sha: string): Promise<CiCheckInfo[]> {
	const result = await pi.exec(
		"gh",
		[
			"api",
			"--paginate",
			`repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
			"--jq",
			".check_runs[] | {id, name, status, conclusion}",
		],
		{ timeout: 30_000 },
	);
	if (result.code !== 0) {
		throw new Error((result.stderr || "").trim() || `gh exited with code ${result.code}`);
	}

	const raw = (result.stdout || "").trim();
	if (!raw) return [];

	const checks: CiCheckInfo[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(`Could not parse check-run output line: ${trimmed.slice(0, 120)}`);
		}

		const record = parsed as {
			id?: unknown;
			name?: unknown;
			status?: unknown;
			conclusion?: unknown;
		};
		if (typeof record?.name !== "string" || typeof record?.status !== "string") {
			throw new Error(`Malformed check-run output line: ${trimmed.slice(0, 120)}`);
		}
		checks.push({
			id: typeof record.id === "number" ? record.id : undefined,
			name: record.name,
			status: record.status,
			conclusion: typeof record.conclusion === "string" ? record.conclusion : null,
		});
	}
	return checks;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
