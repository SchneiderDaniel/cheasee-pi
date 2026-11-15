// ─── PR Readiness Gate Helpers (issue #1472) ─────────────────────
// Extracted from agent-loop.ts (S104 file-size contract, issue #1492).
// runPrReadinessGate: pre-Done PR verification — clean-and-existing PR
// passes; rebase conflicts / dirty PR are resolved by the gate itself
// (auto-merge → developer dispatch → bounded 1× retry) with re-poll.
// blockPipelineOnPrGate: on a blocked verdict, post the blocker comment
// and move the issue to a non-Done status so it is never closed
// COMPLETED without a PR. Returns the stop reason for the loop.

import type {
	AgentRunner,
	PipelineAgentResult,
	PrCreationResult,
	ProjectField,
	ProjectItem,
	SupervisorConfig,
} from "../../config/types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GitHubPort } from "../../github/ports.ts";
import type { ErrorCollector } from "../error-collector.ts";
import { ensurePrReadyForDone } from "../merge.ts";
import { applyStatusTransition } from "../stages/index.ts";
import type { PrBodyInput } from "../pr-creation.ts";
import {
	buildApprovalBodyInput,
	publishApprovalPr,
	refreshBodyForBlockedGate,
} from "./pr-approval-publish.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { postPipelineBlocker } from "./blocker-comment.ts";
import type { RunContext } from "./shared.ts";

async function runPrReadinessGate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentResults: PipelineAgentResult[],
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
	prCreationResult: PrCreationResult | undefined,
	collector: ErrorCollector | undefined,
	port: GitHubPort,
	runner: AgentRunner | undefined,
	prBody: PrBodyInput,
): Promise<{
	prCreationResult: PrCreationResult | undefined;
	blocked: boolean;
	blockerNote?: string;
}> {
	const verdict = await ensurePrReadyForDone(
		pi,
		ctx,
		issueNum,
		issueTitle,
		config,
		agentResults,
		worktreePath,
		worktreeBranch,
		prCreationResult,
		collector,
		port,
		runner,
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
		loopItem,
		projectId,
		fields,
		statusField,
	} = runCtx;

	const prBody = buildApprovalBodyInput(runCtx);
	const created = await publishApprovalPr(runCtx, prBody);

	// Pre-Done readiness gate (issue #1472): a rebase-conflict PR creation
	// failure must NOT complete the pipeline. The gate resolves conflicts
	// (auto-merge → developer dispatch → bounded 1× retry) and re-polls;
	// on blocked, the issue is moved to a non-Done status with a blocker
	// comment instead of Done.
	const gate = await runPrReadinessGate(
		pi,
		ctx,
		issueNum,
		issueTitle,
		config,
		agentResults,
		worktreePath,
		worktreeBranch,
		created,
		collector,
		port,
		runCtx._runner,
		prBody,
	);
	const prCreationResult = gate.prCreationResult;
	if (gate.blocked) {
		const blockerNote =
			gate.blockerNote ?? "PR not ready for Done — manual intervention required.";
		// The body was published as "success" before the gate ran. Refresh the
		// already-published PR with the final status so it is self-describing;
		// update-only, so a vanished PR can never become a duplicate here.
		await refreshBodyForBlockedGate(prBody, blockerNote, prCreationResult, runCtx);
		const stopReason = await blockPipelineOnPrGate(
			port,
			ctx,
			config,
			issueNum,
			loopItem,
			projectId,
			fields,
			statusField,
			loopStatus,
			collector,
			blockerNote,
		);
		// The issue now sits in a non-Done status — the post-pipeline
		// phase must not treat it as complete (never COMPLETED w/o PR).
		return { stop: true, stopReason, loopStatus: "Implementation", prCreationResult };
	}
	return { stop: false, prCreationResult };
}
