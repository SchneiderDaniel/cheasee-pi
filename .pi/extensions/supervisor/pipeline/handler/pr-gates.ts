// ─── PR Readiness Gate Helpers (issue #1472) ─────────────────────
// Extracted from agent-loop.ts (S104 file-size contract, issue #1492).
// runPrReadinessGate: pre-Done PR verification — clean-and-existing PR
// passes; rebase conflicts / dirty PR are resolved by the gate itself
// (auto-merge → developer dispatch → bounded 1× retry) with re-poll.
// blockPipelineOnPrGate: on a blocked verdict, post the blocker comment
// and move the issue to a non-Done status so it is never closed
// COMPLETED without a PR. Returns the stop reason for the loop.

import type {
	PrCreationResult,
	ProjectField,
	ProjectItem,
	SupervisorConfig,
} from "../../config/types.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GitHubPort } from "../../github/ports.ts";
import type { ErrorCollector } from "../error-collector.ts";
import { ensurePrReadyForDone } from "../merge.ts";
import { applyStatusTransition } from "../stages/index.ts";
import {
	buildPrBody,
	createPrOnApproval,
	updateExistingPr,
	type PrBodyInput,
} from "../pr-creation.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { postPipelineBlocker } from "./blocker-comment.ts";
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

/**
 * Refresh the published PR body to the final (blocked) status. Update-only, so
 * this can never open a second PR. A failure is surfaced to the operator
 * (collector + notify); the gate verdict stands, the issue stays out of Done.
 */
async function refreshBodyForBlockedGate(
	runCtx: RunContext,
	prBody: PrBodyInput,
	blockerNote: string,
	prCreationResult: PrCreationResult | undefined,
): Promise<void> {
	const { ctx, config, issueNum, issueTitle, agentResults, collector, port } = runCtx;
	const prNumber = prCreationResult?.prNumber;
	if (!prNumber) {
		getDebugLogger().info("handler", "No PR to refresh — final status skipped", { issueNum });
		return;
	}
	const { title, body } = buildPrBody(issueNum, issueTitle, agentResults, config, {
		...prBody,
		overallStatus: "stopped",
		stopReason: blockerNote,
	});
	const refreshed = await updateExistingPr(
		port,
		config.repo,
		prNumber,
		title,
		body,
		(message, level) => ctx.ui.notify(message, level),
	);
	if (refreshed.success) return;
	ctx.ui.notify(`Failed to refresh PR #${prNumber} to the final status`, "error");
	collector?.push(
		"handler",
		"error",
		`PR #${prNumber} final-status refresh failed: ${refreshed.error}`,
	);
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

async function blockPipelineOnPrGate(
	port: GitHubPort,
	ctx: ExtensionCommandContext,
	config: SupervisorConfig,
	issueNum: number,
	loopItem: ProjectItem,
	projectId: string,
	fields: ProjectField[],
	statusField: ProjectField,
	loopStatus: string,
	collector: ErrorCollector | undefined,
	blockerNote: string,
): Promise<string> {
	// Comment text pinned by handler-part5/pr-approval-flow tests.
	await postPipelineBlocker(
		port,
		ctx,
		config,
		issueNum,
		"## 🔴 PR Readiness Blocked — Manual Intervention Required",
		`${blockerNote}\n\nThe issue stays open in **Implementation**. The next pipeline run re-dispatches the developer with this blocker in context.`,
		collector,
	);
	ctx.ui.notify(`PR readiness blocked for #${issueNum}: ${blockerNote}`, "error");
	try {
		await applyStatusTransition(
			port,
			loopItem.id,
			projectId,
			fields,
			statusField.id,
			"Implementation",
		);
		ctx.ui.notify(
			`Issue #${issueNum} moved: ${loopStatus} → Implementation (PR blocked)`,
			"warning",
		);
		getDebugLogger().info("handler", "PR blocked — issue moved to Implementation", {
			loopStatus,
		});
	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Failed to move issue to Implementation: ${errMsg}`, "error");
		collector?.push("handler", "error", `Status transition to Implementation failed: ${errMsg}`);
	}
	return `PR readiness gate blocked: ${blockerNote}`;
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
	const { ctx, issueNum, config, loopItem, projectId, fields, statusField } = runCtx;

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
	if (!gate.blocked) return { stop: false, prCreationResult };

	const blockerNote = gate.blockerNote ?? "PR not ready for Done — manual intervention required.";
	// The body was published as "success" before the gate ran. Refresh the
	// already-published PR to the final status so it is self-describing;
	// update-only, so a vanished PR can never become a duplicate here.
	await refreshBodyForBlockedGate(runCtx, prBody, blockerNote, prCreationResult);
	const stopReason = await blockPipelineOnPrGate(
		runCtx.port,
		ctx,
		config,
		issueNum,
		loopItem,
		projectId,
		fields,
		statusField,
		loopStatus,
		runCtx.collector,
		blockerNote,
	);
	// The issue now sits in a non-Done status — the post-pipeline
	// phase must not treat it as complete (never COMPLETED w/o PR).
	return { stop: true, stopReason, loopStatus: "Implementation", prCreationResult };
}
