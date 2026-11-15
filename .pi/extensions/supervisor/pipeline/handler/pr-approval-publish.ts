// ─── Approval PR publication (issue #1831) ───────────────────────
// Side effects of the audit-approval step: build the one body input the
// approval reuses everywhere, publish (create-or-update) the PR, and
// refresh its body with the final status once the readiness gate decided.
// The sequencing that calls these helpers stays in pr-gates.ts.

import type { PrCreationResult } from "../../config/types.ts";
import { buildPrBody, createPrOnApproval, type PrBodyInput } from "../pr-creation.ts";
import { publishPrFinalStatus } from "../pr-publish.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import type { RunContext } from "./shared.ts";

/**
 * The single body input shared by the approval publish, the gate's bounded
 * retry and the final-status refresh, so a retry can never drop the gate
 * history or the auditor verdict.
 *
 * Package safety is NOT plumbed: `runPackageSafetyAudit` runs inside the
 * pre-audit gate and its result is not retained past it, so there is no state
 * to read here. `packageSafetyResult` therefore stays unset on the approval
 * body (the auditor's own review still reports it).
 */
export function buildApprovalBodyInput(runCtx: RunContext): PrBodyInput {
	return {
		overallStatus: "success",
		gateFailureHistory: runCtx.stageState.gateFailureHistory,
		auditVerdict: runCtx.auditVerdict,
	};
}

/** Publish (create-or-update) the approval PR with the shared body input. */
export async function publishApprovalPr(
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
 * Refresh the published PR body with the final (blocked) status.
 * Update-only, so this can never open a second PR. Failures reach the
 * operator and the collector; the gate verdict is unaffected (the issue
 * still stays out of Done).
 */
export async function refreshBodyForBlockedGate(
	prBody: PrBodyInput,
	blockerNote: string,
	prCreationResult: PrCreationResult | undefined,
	runCtx: RunContext,
): Promise<void> {
	const { ctx, config, issueNum, issueTitle, agentResults, collector, port } = runCtx;
	const prNumber = prCreationResult?.prNumber;
	if (!prNumber) {
		getDebugLogger().info("handler", "No PR to refresh with the final status", { issueNum });
		return;
	}
	const refreshed = await publishPrFinalStatus({
		repo: config.repo,
		issueNum,
		issueTitle,
		agentResults,
		config,
		prNumber,
		prBody,
		stopReason: blockerNote,
		port,
		notify: (message, level) => ctx.ui.notify(message, level),
	});
	if (refreshed.success) return;
	ctx.ui.notify(`Failed to refresh PR #${prNumber} with the final status`, "error");
	collector?.push(
		"handler",
		"error",
		`PR #${prNumber} final-status refresh failed: ${refreshed.error}`,
	);
}
