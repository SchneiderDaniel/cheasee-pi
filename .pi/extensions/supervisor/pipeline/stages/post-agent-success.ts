// ─── Pipeline Stages — post-agent-success orchestration ──────────
// Thin delegator: routes each agent's post-success side effects to the
// per-phase modules (agent-comment, git-ops, auditor-output). Signature
// and return semantics are unchanged from the pre-split stages.ts:
// returns false ONLY on commitAndPush failure.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	AgentRunResult,
	FilteredIssueData,
	PipelineAgentResult,
} from "../../config/types.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { NotifyFn } from "../helpers.ts";
import type { GateRejected } from "./core.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { handleAgentComment } from "./agent-comment.ts";
import { handleDeveloperCommit } from "./git-ops.ts";
import { upsertDeveloperPr } from "./developer-pr.ts";
import { handleAuditorOutput } from "./auditor-output.ts";

/**
 * Handle post-agent-success side effects: issue comments, commit/push,
 * auditor output dispatch.
 */
export async function handlePostAgentSuccess(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	result: AgentRunResult,
	agentName: string,
	issueNum: number,
	config: SupervisorConfig,
	loopFilteredData: FilteredIssueData,
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
	issueTitle: string,
	collector?: ErrorCollector,
	gateRejected?: GateRejected,
	notify?: NotifyFn,
	port?: GitHubPort,
	agentResults?: PipelineAgentResult[],
): Promise<boolean> {
	// Agent comments: architect, test-designer, researcher
	if (agentName === "architect" || agentName === "test-designer" || agentName === "researcher") {
		await handleAgentComment(pi, ctx, result, agentName, issueNum, config, collector, port);
	}

	// Commit and push for developer, then upsert the PR so pre-audit CI gates
	// have a pull request to evaluate (the developer agent never touches git/PRs).
	if (agentName === "developer" && worktreePath && worktreeBranch) {
		const committed = await handleDeveloperCommit(
			pi,
			ctx,
			config,
			worktreePath,
			worktreeBranch,
			issueNum,
			issueTitle,
			collector,
			notify,
		);
		if (committed) {
			await upsertDeveloperPr({
				pi,
				issueNum,
				issueTitle,
				config,
				worktreePath,
				worktreeBranch,
				agentResults,
				port,
				notify,
				collector,
			});
		}
		return committed;
	}

	// Audit output processing
	if (agentName === "auditor") {
		// Use textOutput over textOnly — textOnly can be very short (3 chars) for
		// models like minimax-m3 that emit structured JSON with minimal text lines,
		// causing the || chain to shadow the full output. Mirror the other agents'
		// fallback pattern: textOutput always contains the full agent log + JSON.
		const auditorOutput = result.textOutput || result.output || "";
		await handleAuditorOutput(
			pi,
			ctx,
			auditorOutput,
			result,
			issueNum,
			config,
			collector,
			gateRejected,
			port,
			loopFilteredData,
		);
	}

	// Default: pipeline should continue
	return true;
}
