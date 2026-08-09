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
import { getDebugLogger } from "../../lib/debug.ts";

export async function runPrReadinessGate(
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

export async function blockPipelineOnPrGate(
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
	try {
		await port.postIssueComment(
			issueNum,
			config.repo,
			`## 🔴 PR Readiness Blocked — Manual Intervention Required\n\n${blockerNote}\n\nThe issue stays open in **Implementation**. The next pipeline run re-dispatches the developer with this blocker in context.`,
		);
		ctx.ui.notify(`PR readiness blocked for #${issueNum}: ${blockerNote}`, "error");
	} catch (commentErr: unknown) {
		const commentMsg = commentErr instanceof Error ? commentErr.message : String(commentErr);
		ctx.ui.notify(`Failed to post blocker comment: ${commentMsg}`, "warning");
		collector?.push(
			"handler",
			"warn",
			`Failed to post PR blocker comment on issue #${issueNum}: ${commentMsg}`,
		);
	}
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
