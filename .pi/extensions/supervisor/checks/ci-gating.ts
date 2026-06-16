// ─── CI Gating ──────────────────────────────────────────────────────
// Polls GitHub check runs before dispatching auditor. Short-circuits
// pipeline if CI is failing — saves tokens by not reviewing broken code.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CiCheckInfo {
	name: string;
	status: string;
	conclusion: string | null;
}

export interface CiPollResult {
	status: "passing" | "failing" | "pending" | "error" | "unconfigured";
	checks: CiCheckInfo[];
	message: string;
}

/**
 * Poll CI check runs for the given branch.
 *
 * Uses `gh api` to query check runs for the latest commit on the branch.
 * Polls every 15 seconds up to `timeoutSec`. Returns early if all checks
 * complete or any check fails.
 *
 * Edge cases:
 * - No checks configured → returns { status: "error" } (fail-open)
 * - `gh api` permission error → returns { status: "error" }
 * - Checks re-triggered mid-poll → stays in loop until all terminal or timeout
 * - Branch SHA not found on remote → attempts push from local worktree (Bug 5)
 */
export async function pollCiChecks(
	pi: ExtensionAPI,
	branch: string,
	repo: string,
	timeoutSec: number,
	/** Worktree path to attempt push recovery if remote SHA not found */
	worktreePath?: string,
): Promise<CiPollResult> {
	const POLL_INTERVAL_MS = 15_000;
	const startTime = Date.now();
	const deadline = startTime + timeoutSec * 1000;

	// Resolve branch SHA — may not exist if commitAndPush failed
	let sha: string;
	try {
		const result = await pi.exec("git", ["rev-parse", `origin/${branch}`], { timeout: 10_000 });
		sha = (result.stdout || "").trim();
		if (!sha) {
			// ── Bug 5 fix: attempt push recovery from worktree ──
			// If commitAndPush failed silently, origin/${branch} SHA won't exist.
			// Try pushing from local worktree to recover, then re-check SHA.
			if (worktreePath) {
				const recoveredSha = await attemptPushRecovery(pi, branch, worktreePath);
				if (recoveredSha) {
					sha = recoveredSha;
				} else {
					return {
						status: "error",
						checks: [],
						message: `Branch '${branch}' SHA not found on remote and push recovery failed. Proceeding without CI gating.`,
					};
				}
			}
			if (!sha) {
				return {
					status: "error",
					checks: [],
					message: `Could not resolve branch '${branch}' SHA.`,
				};
			}
		}
	} catch {
		// ── Bug 5 fix: same push recovery on catch ──
		if (worktreePath) {
			const recoveredSha = await attemptPushRecovery(pi, branch, worktreePath);
			if (recoveredSha) {
				sha = recoveredSha;
			} else {
				return {
					status: "error",
					checks: [],
					message: `Branch '${branch}' not found on remote and push recovery failed.`,
				};
			}
		} else {
			return {
				status: "error",
				checks: [],
				message: `Branch '${branch}' not found or not pushed to remote.`,
			};
		}
	}

	let lastChecks: CiCheckInfo[] = [];

	while (Date.now() < deadline) {
		try {
			const result = await pi.exec(
				"gh",
				[
					"api",
					`repos/${repo}/commits/${sha}/check-runs`,
					"--jq",
					".check_runs[] | {name, status, conclusion}",
				],
				{ timeout: 15_000 },
			);

			const raw = (result.stdout || "").trim();
			if (!raw) {
				// No check runs at all — not an error, just unconfigured
				return {
					status: "unconfigured",
					checks: [],
					message: "No CI checks configured for this repo. Skipping CI gating.",
				};
			}

			// Parse each line as individual JSON (gh --jq outputs one JSON per item)
			const lines = raw.split("\n");
			const checks: CiCheckInfo[] = lines
				.filter((l) => l.trim())
				.map((l) => {
					try {
						return JSON.parse(l) as CiCheckInfo;
					} catch {
						return null;
					}
				})
				.filter((c): c is CiCheckInfo => c !== null);

			lastChecks = checks;

			// Classify check conclusions
			const terminalConclusions = new Set([
				"success",
				"failure",
				"neutral",
				"cancelled",
				"skipped",
				"timed_out",
				"action_required",
				"stale",
			]);
			const failureConclusions = new Set([
				"failure",
				"cancelled",
				"action_required",
				"timed_out",
				"stale",
			]);

			let anyFailure = false;
			let allTerminal = true;

			for (const check of checks) {
				if (failureConclusions.has(check.conclusion || "")) {
					anyFailure = true;
				}
				if (!check.conclusion || !terminalConclusions.has(check.conclusion)) {
					allTerminal = false;
				}
			}

			// If any check failed — short-circuit immediately
			if (anyFailure) {
				const failingChecks = checks.filter((c) => failureConclusions.has(c.conclusion || ""));
				const failedNames = failingChecks.map((c) => c.name).join(", ");
				return {
					status: "failing",
					checks,
					message: `CI checks failing: ${failedNames}.`,
				};
			}

			// If all checks have terminal conclusions — all passing
			if (allTerminal && checks.length > 0) {
				return {
					status: "passing",
					checks,
					message: `All ${checks.length} CI check(s) passing.`,
				};
			}

			// Still pending — wait and poll again
			await sleep(POLL_INTERVAL_MS);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				status: "error",
				checks: lastChecks,
				message: `CI check polling error: ${msg}. Proceeding without CI gating.`,
			};
		}
	}

	// Timeout reached — checks still pending
	return {
		status: "pending",
		checks: lastChecks,
		message: `CI checks still pending after ${timeoutSec}s timeout. Proceeding to audit.`,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt push recovery for CI gating when origin/branch SHA is not found.
 * Pushes the branch from worktree and retries SHA resolution.
 * Returns the SHA string on success, null on failure.
 */
async function attemptPushRecovery(
	pi: ExtensionAPI,
	branch: string,
	worktreePath: string,
): Promise<string | null> {
	try {
		await pi.exec("git", ["push", "origin", branch], {
			cwd: worktreePath,
			timeout: 15_000,
		});
		// Retry SHA resolution after push
		const retryResult = await pi.exec("git", ["rev-parse", `origin/${branch}`], {
			timeout: 10_000,
		});
		const sha = (retryResult.stdout || "").trim();
		return sha || null;
	} catch {
		return null;
	}
}
