// ─── PR Readiness Gate Helpers (issue #1472) ─────────────────────
// Extracted from agent-loop.ts (S104 file-size contract, issue #1492).
// runPrReadinessGate: pre-Done PR verification — clean-and-existing PR
// passes; rebase conflicts / dirty PR are resolved by the gate itself
// (auto-merge → developer dispatch → bounded 1× retry) with re-poll.
// The blocked branch posts its blocker (with the status move) through
// `blockPrReadinessGate`, so the issue is never closed COMPLETED w/o PR.

import type { PrCreationResult } from "../../config/types.ts";
import { ensurePrReadyForDone } from "../merge.ts";
import { generateBranchName } from "../../lib/branch-name.ts";
import { createPrOnApproval, publishPrBody, type PrBodyInput } from "../pr-creation.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { blockPrReadinessGate } from "./blocker-comment.ts";
import type { RunContext } from "./shared.ts";

/**
 * The single body input the approval path shares (issue #1831): the publish,
 * the gate's bounded retry, the final-status refresh all take this one object,
 * so a retry can never drop the gate history or the auditor verdict.
 *
 * Package safety is NOT plumbed: `runPackageSafetyAudit` runs inside the
 * pre-audit gate and its result is not retained past it, so there is no state
 * to read here. `packageSafetyResult` therefore stays unset on the approval
 * body (the auditor's own review still reports it).
 */
function buildApprovalBodyInput(runCtx: RunContext): PrBodyInput {
	return {
		overallStatus: "success",
		gateFailureHistory: runCtx.stageState.gateFailureHistory,
		auditVerdict: runCtx.auditVerdict,
	};
}

/** Head branch the approval PR lives on (same derivation the gate uses). */
function approvalBranch(runCtx: RunContext): string {
	const { issueNum, issueTitle, config, worktreeBranch } = runCtx;
	return worktreeBranch ?? generateBranchName(issueNum, issueTitle, config.branchPrefix!);
}

/** One update-only body write through the single publisher (pr-creation.ts). */
function writeApprovalBody(
	runCtx: RunContext,
	prBody: PrBodyInput,
	prNumber?: number,
): Promise<PrCreationResult> {
	const { ctx, config, issueNum, issueTitle, agentResults, port } = runCtx;
	return publishPrBody({
		repo: config.repo,
		head: approvalBranch(runCtx),
		issueNum,
		issueTitle,
		agentResults,
		config,
		body: prBody,
		port,
		prNumber,
		notify: (message, level) => ctx.ui.notify(message, level),
	});
}

/**
 * Refresh the published PR body to the final (blocked) status. Update-only, so
 * this can never open a second PR. A failure reaches the operator (collector +
 * notify); the gate verdict stands, the issue stays out of Done.
 */
async function refreshBodyForBlockedGate(
	runCtx: RunContext,
	prBody: PrBodyInput,
	blockerNote: string,
	prNumber?: number,
): Promise<void> {
	if (!prNumber) {
		getDebugLogger().info("handler", "No PR to refresh for the final status", {
			issueNum: runCtx.issueNum,
		});
		return;
	}
	const refreshed = await writeApprovalBody(
		runCtx,
		{ ...prBody, overallStatus: "stopped", stopReason: blockerNote },
		prNumber,
	);
	if (refreshed.success) return;
	runCtx.ctx.ui.notify(`Failed to refresh PR #${prNumber} for the final status`, "error");
	runCtx.collector?.push(
		"handler",
		"error",
		`PR #${prNumber} final-status refresh failed: ${refreshed.error}`,
	);
}

/** Blocker note for a body that could not be published, error detail included. */
function bodyPublishFailureNote(detail: string | undefined): string {
	return `Approval PR body could not be published: ${detail ?? "no error reported"} — manual intervention required.`;
}

/**
 * Confirm the approval body is on the PR before the issue may reach Done.
 * `createPrOnApproval` normally published it, but a failed write can still be
 * followed by a passing gate on an earlier, still-visible PR — Done would then
 * leave the in-progress body without the auditor result (issue #1831, audit
 * #2). One bounded re-publish; no PR to write to blocks Done.
 *
 * The returned `result` is the publish that actually carries the body, so the
 * completion summary reports the real PR instead of the failed attempt.
 */
async function ensureApprovalBodyPublished(
	runCtx: RunContext,
	prBody: PrBodyInput,
	published: PrCreationResult | undefined,
): Promise<{ result?: PrCreationResult; error?: string }> {
	// A publish this run already wrote this exact input (the gate's bounded
	// retry reuses the same PrBodyInput) — no second write needed.
	if (published?.success) return { result: published };
	const refreshed = await writeApprovalBody(runCtx, prBody);
	if (refreshed.success) return { result: refreshed };
	runCtx.collector?.push(
		"handler",
		"error",
		`Approval PR body could not be published: ${refreshed.error}`,
	);
	return { error: refreshed.error };
}

async function runPrReadinessGate(
	runCtx: RunContext,
	prCreationResult: PrCreationResult | undefined,
	prBody: PrBodyInput,
): Promise<{
	prCreationResult: PrCreationResult | undefined;
	blocked: boolean;
	blockerNote?: string;
}> {
	const verdict = await ensurePrReadyForDone(
		runCtx.pi,
		runCtx.ctx,
		runCtx.issueNum,
		runCtx.issueTitle,
		runCtx.config,
		runCtx.agentResults,
		runCtx.worktreePath,
		runCtx.worktreeBranch,
		prCreationResult,
		runCtx.collector,
		runCtx.port,
		runCtx._runner,
		undefined,
		prBody,
	);
	const final = verdict.prCreationResult ?? prCreationResult;
	if (final && !final.success) {
		getDebugLogger().warn("handler", "PR creation failed", {
			error: final.error,
			rebaseConflicts: final.rebaseConflicts,
		});
	}
	if (!verdict.ok) {
		const blockerNote =
			verdict.blockerNote ?? "PR not ready for Done — manual intervention required.";
		getDebugLogger().warn("handler", "PR readiness gate blocked Done transition", {
			blockerNote,
		});
		return { prCreationResult: final, blocked: true, blockerNote };
	}
	return { prCreationResult: final, blocked: false };
}

/**
 * Publish (create-or-update) the approval PR from the shared body input.
 * `createPrOnApproval` is the only publisher, so the branch that already got an
 * early upsert is updated rather than duplicated (issue #1831, AC1).
 */
async function publishApprovalPr(
	runCtx: RunContext,
	prBody: PrBodyInput,
): Promise<PrCreationResult> {
	const {
		ctx,
		pi,
		issueNum,
		issueTitle,
		config,
		agentResults,
		worktreePath,
		worktreeBranch,
		collector,
		port,
	} = runCtx;

	// Debug tracing: agentResults before PR creation (R3 requirement)
	getDebugLogger().info("handler", "agentResults before PR creation", {
		length: agentResults.length,
		entries: agentResults.map((a) => ({
			name: a.agentName,
			status: a.status,
			tokens: a.tokenCount,
		})),
	});
	getDebugLogger().info("handler", "Creating PR on approval");
	return createPrOnApproval(
		pi,
		ctx,
		issueNum,
		issueTitle,
		config,
		agentResults,
		worktreePath,
		worktreeBranch,
		collector,
		prBody,
		port,
	);
}

/**
 * Audit-approval → PR-creation + readiness gate glue, extracted from
 * runAgentLoop (S104/S138 ceiling, issue #1533). On a blocked verdict
 * the issue is moved to a non-Done status (never COMPLETED w/o PR) and
 * the loop stops. prCreationResult is returned on BOTH branches — the
 * blocked path must still propagate the failed PR result to the
 * post-pipeline phase (handler.test.mts pins it).
 */
export async function handlePrApprovalFlow(
	runCtx: RunContext,
	loopStatus: string,
): Promise<
	| {
			stop: true;
			stopReason: string;
			loopStatus: string;
			prCreationResult: PrCreationResult | undefined;
	  }
	| { stop: false; prCreationResult: PrCreationResult | undefined }
> {
	// One body input for the whole approval path (issue #1831): publish, gate
	// retry, final-status refresh. A retry can never drop the audit verdict.
	const prBody = buildApprovalBodyInput(runCtx);
	const created = await publishApprovalPr(runCtx, prBody);

	// Pre-Done readiness gate (issue #1472): a rebase-conflict PR creation
	// failure must NOT complete the pipeline. The gate resolves conflicts
	// (auto-merge → developer dispatch → bounded 1× retry) and re-polls;
	// on blocked, the issue is moved to a non-Done status with a blocker
	// comment instead of Done.
	const gate = await runPrReadinessGate(runCtx, created, prBody);
	const prCreationResult = gate.prCreationResult;
	const prNumber = prCreationResult?.prNumber;
	let bodyFailure: string | undefined;
	if (!gate.blocked) {
		// Done requires the PR to carry this run's approval body: a failed
		// publish leaves the earlier, still-visible PR clean, so a passing gate
		// would complete the issue on the in-progress body (issue #1831, audit
		// #2).
		const body = await ensureApprovalBodyPublished(runCtx, prBody, prCreationResult);
		if (body.result) return { stop: false, prCreationResult: body.result };
		bodyFailure = body.error ?? prCreationResult?.error;
	}

	const blockerNote =
		gate.blockerNote ?? bodyPublishFailureNote(bodyFailure ?? prCreationResult?.error);
	// The body was published as "success" before the gate ran. Refresh the
	// already-published PR to the final status so it is self-describing;
	// update-only, so a vanished PR can never become a duplicate here.
	await refreshBodyForBlockedGate(runCtx, prBody, blockerNote, prNumber);
	const stopReason = await blockPrReadinessGate(runCtx, blockerNote, loopStatus);
	// The issue now sits in a non-Done status — the post-pipeline
	// phase must not treat it as complete (never COMPLETED w/o PR).
	return { stop: true, stopReason, loopStatus: "Implementation", prCreationResult };
}
