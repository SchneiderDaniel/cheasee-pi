// ─── Pipeline Merge: PR Readiness Gate helpers ────────────────────
// Split out of merge.ts (issue #2005 Long File refactor). The PR
// mergeability poll, the verdict classifier and the bounded round
// handlers (handleMissingPr / handleSettledPrState) the pre-Done gate
// (ensurePrReadyForDone, in merge.ts) drives round-by-round.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	PrConflictInfo,
	PrCreationResult,
	PipelineAgentResult,
	SupervisorConfig,
	AgentRunner,
} from "../config/types.ts";
import type { GitHubPort } from "../github/ports.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";
import { createPrOnApproval } from "./pr-creation.ts";
import { resolveBranchConflicts } from "./merge-conflicts.ts";

// ─── PR Readiness Gate ───────────────────────────────────────────
// Verdict of the pre-Done gate. ok:false carries a blockerNote the
// controller posts to the issue before transitioning to a non-Done
// status. prCreationResult reflects the latest attempt (after any
// bounded retry) so the post-pipeline phase sees the final state.

export interface PrGateVerdict {
	ok: boolean;
	prCreationResult?: PrCreationResult;
	blockerNote?: string;
}

// ─── Mergeability Poll ────────────────────────────────────────────
// REST `mergeable` is null right after PR creation (GitHub starts a
// background job), so a single read can false-fail (UNKNOWN) or
// false-pass (stale null). Poll until the state settles. Returns null
// on exhaustion or when the PR disappears — callers treat null as
// fail-open (the post-Done backstop still catches stragglers).
export async function awaitPrMergeability(
	port: GitHubPort,
	branch: string,
	repo: string,
	polls: { attempts: number; backoffMs: number[] } = {
		attempts: 5,
		backoffMs: [2000, 4000, 8000, 16000, 32000],
	},
): Promise<PrConflictInfo | null> {
	const log = getDebugLogger();
	for (let i = 0; i < polls.attempts; i++) {
		let info: PrConflictInfo | null = null;
		try {
			info = await port.listPullRequestsForBranch(branch, repo);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("pipeline-merge", `Mergeability poll ${i + 1}/${polls.attempts} failed: ${msg}`);
			return null; // fail-open — caller treats as exhausted
		}
		if (!info) return null;
		if (info.mergeable !== "UNKNOWN") return info;
		if (i < polls.attempts - 1) {
			await new Promise((resolve) => setTimeout(resolve, polls.backoffMs[i] ?? 2000));
		}
	}
	return null;
}

// ─── Mergeability Classification ───────────────────────────────────
// Pure policy over the GitHub mergeability vocabulary (mirrors
// mapRestPrToConflictInfo): only `dirty` counts as a conflict, UNKNOWN
// means GitHub is still computing (never a verdict — the poll loop
// re-checks), and a missing PR is classified by the last creation result.

export type MergeabilityClass =
	| { kind: "clean"; prNumber: number }
	| { kind: "dirty"; prNumber: number }
	| { kind: "computing" }
	| { kind: "no-pr"; mode: "rebase-conflicts" | "creation-failed" | "propagating" };

export function classifyMergeability(
	info: PrConflictInfo | null,
	current: PrCreationResult | undefined,
): MergeabilityClass {
	if (!info) {
		if (current && !current.success && (current.rebaseConflicts?.length ?? 0) > 0) {
			return { kind: "no-pr", mode: "rebase-conflicts" };
		}
		if (current && !current.success) {
			return { kind: "no-pr", mode: "creation-failed" };
		}
		return { kind: "no-pr", mode: "propagating" };
	}
	if (info.hasConflict) return { kind: "dirty", prNumber: info.number };
	if (info.mergeable === "UNKNOWN") return { kind: "computing" };
	return { kind: "clean", prNumber: info.number };
}

// ─── Pre-Done Readiness Gate ──────────────────────────────────────
// Verdict: clean-and-existing PR → ok. Rebase conflicts (no PR, #1455)
// or dirty PR (#1457) → resolve → bounded 1× retry of createPrOnApproval
// → re-poll. Failure → ok:false with a blockerNote; the controller keeps
// the issue in a non-Done status instead of completing it.

/** Invariant gate inputs, bundled once so the round handlers stay shallow. */
export interface PrGateDeps {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	issueNum: number;
	issueTitle: string;
	config: SupervisorConfig;
	agentResults: PipelineAgentResult[];
	worktreePath: string | undefined;
	worktreeBranch: string | undefined;
	collector?: ErrorCollector;
	runner?: AgentRunner;
	port: GitHubPort;
}

/** Mutable per-round state shared between the loop and its handlers. */
export interface RoundState {
	current: PrCreationResult | undefined;
	retried: boolean;
}

/** Seam between the round loop and handlers: a final verdict or keep looping. */
type RoundOutcome = { verdict: PrGateVerdict } | { continue: true };

/** Single bounded createPrOnApproval retry — shared by all resolution paths. */
async function retryCreatePr(deps: PrGateDeps): Promise<PrCreationResult> {
	return createPrOnApproval(
		deps.pi,
		deps.ctx,
		deps.issueNum,
		deps.issueTitle,
		deps.config,
		deps.agentResults,
		deps.worktreePath,
		deps.worktreeBranch,
		deps.collector,
		undefined,
		undefined,
		deps.port,
	);
}

/** No-PR branch of the gate: rebase-conflict recovery, bounded creation retry, or propagation poll. */
export async function handleMissingPr(
	deps: PrGateDeps,
	state: RoundState,
	branch: string,
	mergePoll: { attempts: number; backoffMs: number[] },
	mode: "rebase-conflicts" | "creation-failed" | "propagating",
): Promise<RoundOutcome> {
	const log = getDebugLogger();
	const { current } = state;

	if (mode === "rebase-conflicts") {
		if (state.retried) {
			return {
				verdict: {
					ok: false,
					prCreationResult: current,
					blockerNote:
						"PR creation still failing with rebase conflicts after developer resolution — manual intervention required.",
				},
			};
		}
		log.warn("pipeline-merge", "PR creation failed with rebase conflicts and no PR — resolving", {
			branch,
			rebaseConflicts: current!.rebaseConflicts,
		});
		const resolved = await resolveBranchConflicts(
			deps.issueNum,
			branch,
			undefined,
			deps.config,
			deps.pi,
			deps.ctx,
			deps.worktreePath,
			deps.collector,
			deps.runner,
			current!.rebaseConflicts,
		);
		if (!resolved.ok) {
			return {
				verdict: {
					ok: false,
					prCreationResult: current,
					blockerNote:
						resolved.note ??
						"Rebase conflicts could not be resolved — manual intervention required.",
				},
			};
		}
		state.retried = true;
		state.current = await retryCreatePr(deps);
		return { continue: true };
	}

	if (mode === "creation-failed") {
		if (state.retried) {
			return {
				verdict: {
					ok: false,
					prCreationResult: current,
					blockerNote: `PR creation failed: ${current!.error ?? "unknown error"} — manual intervention required.`,
				},
			};
		}
		log.warn("pipeline-merge", "PR creation failed — one bounded retry before blocking Done", {
			branch,
			error: current!.error,
		});
		state.retried = true;
		state.current = await retryCreatePr(deps);
		return { continue: true };
	}

	// PR created (or no result) but not yet visible — poll for
	// propagation, then fail-open (documented false-Done window).
	const settled = await awaitPrMergeability(deps.port, branch, deps.config.repo, {
		attempts: Math.min(mergePoll.attempts, 3),
		backoffMs: mergePoll.backoffMs,
	});
	log.warn(
		"pipeline-merge",
		settled
			? "PR became visible after propagation poll"
			: "No PR visible after propagation poll — proceeding fail-open",
		{ branch, prNumber: settled?.number },
	);
	return { verdict: { ok: true, prCreationResult: state.current } };
}

/** PR-exists branch of the gate: clean passes, dirty resolves (auto-merge → dev dispatch → retry). */
export async function handleSettledPrState(
	deps: PrGateDeps,
	state: RoundState,
	branch: string,
	settled: PrConflictInfo,
): Promise<RoundOutcome> {
	const log = getDebugLogger();

	if (!settled.hasConflict) {
		log.info("pipeline-merge", `PR #${settled.number} is clean — Done gate passes`, {
			mergeStateStatus: settled.mergeStateStatus,
		});
		return { verdict: { ok: true, prCreationResult: state.current } };
	}

	log.warn("pipeline-merge", `PR #${settled.number} has conflicts — resolving before Done`, {
		mergeStateStatus: settled.mergeStateStatus,
	});
	if (state.retried) {
		return {
			verdict: {
				ok: false,
				prCreationResult: state.current,
				blockerNote: "PR still conflicting after resolution — manual intervention required.",
			},
		};
	}
	const resolved = await resolveBranchConflicts(
		deps.issueNum,
		branch,
		settled.number,
		deps.config,
		deps.pi,
		deps.ctx,
		deps.worktreePath,
		deps.collector,
		deps.runner,
	);
	if (!resolved.ok) {
		return {
			verdict: {
				ok: false,
				prCreationResult: state.current,
				blockerNote:
					resolved.note ?? "PR conflicts could not be resolved — manual intervention required.",
			},
		};
	}
	if (resolved.devDispatched) {
		state.retried = true;
		state.current = await retryCreatePr(deps);
	}
	// Auto-merge success (or retry done) — next round re-polls to confirm clean.
	return { continue: true };
}
