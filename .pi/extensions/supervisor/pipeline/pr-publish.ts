// ─── PR Publishing — final-status refresh ────────────────────────
// The update-only half of the PR publisher (issue #1831). Approval code
// never calls `port.updatePullRequest` directly: publishing (list →
// create-or-update) stays in pr-creation.ts, and this module owns the
// body-only refresh the approval path runs once the readiness gate has
// decided the final status. Update-only by construction — a refresh can
// never open a second PR.

import type { PipelineAgentResult, PrCreationResult, SupervisorConfig } from "../config/types.ts";
import type { GitHubPort } from "../github/ports.ts";
import {
	buildPrBody,
	updateExistingPr,
	type PrBodyInput,
	type PrNotify,
} from "./pr-creation.ts";

/**
 * Final-status refresh of an already-published PR.
 * A vanished PR surfaces as a failure for the caller to report instead of
 * silently creating a duplicate; a missing port fails closed.
 */
export async function refreshPrBody(input: {
	repo: string;
	prNumber: number;
	title: string;
	body: string;
	port?: GitHubPort;
	notify?: PrNotify;
}): Promise<PrCreationResult> {
	if (!input.port) {
		input.notify?.("GitHubPort not available for PR body refresh", "error");
		return {
			success: false,
			error: "GitHubPort not available for PR body refresh",
			source: "pr-creation",
		};
	}
	return await updateExistingPr(
		input.port,
		input.repo,
		input.prNumber,
		input.title,
		input.body,
		input.notify,
	);
}

/**
 * Rewrite an already-published PR with the final pipeline status.
 * Body text stays `buildPrBody`'s business; this only chooses the body
 * variant (stopped + its stop reason) and performs the update.
 */
export async function publishPrFinalStatus(input: {
	repo: string;
	issueNum: number;
	issueTitle: string;
	agentResults: PipelineAgentResult[];
	config: SupervisorConfig | undefined;
	prNumber: number;
	prBody: PrBodyInput;
	stopReason: string;
	port?: GitHubPort;
	notify?: PrNotify;
}): Promise<PrCreationResult> {
	const { title, body } = buildPrBody(
		input.issueNum,
		input.issueTitle,
		input.agentResults,
		input.config,
		{ ...input.prBody, overallStatus: "stopped", stopReason: input.stopReason },
	);
	return refreshPrBody({
		repo: input.repo,
		prNumber: input.prNumber,
		title,
		body,
		port: input.port,
		notify: input.notify,
	});
}
