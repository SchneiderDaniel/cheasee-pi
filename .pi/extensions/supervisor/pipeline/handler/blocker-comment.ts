// ─── Pipeline Blocker Comments (issue #1830) ─────────────────────
// A blocker is a comment, never a status change: the caller owns the
// decision (the PR readiness gate also moves the issue, the CI gate
// leaves the status untouched). Extracted so the PR and CI gates share
// one poster without importing each other's module. The CI loop-back
// recorder lives here too: both callbacks are "what a CI block writes",
// and keeping them together keeps agent-loop-helpers under its file cap.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import type { ErrorCollector } from "../error-collector.ts";
import { recordCiLoopBack } from "../stages/audit-rejection-ops.ts";
import type { postCiGateRejection } from "../stages/audit-rejection-ops.ts";
import type { upsertDeveloperPr } from "../stages/git-ops.ts";
import type { RunContext } from "./shared.ts";

/** Header for a run stopped because CI could not be verified (AC3). */
const CI_BLOCKER_TITLE = "## 🔴 CI Verification Blocked — Pipeline Stopped";

/** Footer for a CI blocker: the issue is not Done and stays where it was. */
const CI_BLOCKER_FOOTER =
	"The issue is **not** Done. Its status is unchanged — CI could not be verified, so the pipeline stopped instead of re-dispatching the developer.\n\nRe-run the pipeline once CI is reachable and green.";

/**
 * Post `title` + `body` as one issue comment.
 *
 * Never throws and never touches the issue status: a failed comment is
 * surfaced to the operator AND collected, so the stop is never log-only.
 */
export async function postPipelineBlocker(
	port: GitHubPort,
	ctx: ExtensionCommandContext,
	config: SupervisorConfig,
	issueNum: number,
	title: string,
	body: string,
	collector: ErrorCollector | undefined,
): Promise<void> {
	try {
		await port.postIssueComment(issueNum, config.repo, `${title}\n\n${body}`);
	} catch (commentErr: unknown) {
		const commentMsg = commentErr instanceof Error ? commentErr.message : String(commentErr);
		ctx.ui.notify(`Failed to post blocker comment: ${commentMsg}`, "warning");
		collector?.push(
			"handler",
			"warn",
			`Failed to post blocker comment on issue #${issueNum}: ${commentMsg}`,
		);
	}
}

/**
 * Post the CI blocker for an unverifiable CI verdict (AC1/AC2/AC3) and return
 * the stop reason the loop reports. `reason` is the gate's own text: the `gh`
 * error, or the names of the checks still pending at `ciGatingTimeoutSec`.
 */
export async function postCiVerificationBlocker(
	runCtx: RunContext,
	reason: string,
): Promise<string> {
	const { ctx, port, config, issueNum, collector } = runCtx;
	await postPipelineBlocker(
		port,
		ctx,
		config,
		issueNum,
		CI_BLOCKER_TITLE,
		`${reason}\n\n${CI_BLOCKER_FOOTER}`,
		collector,
	);
	return `CI verification blocked — pipeline stopped: ${reason}`;
}

/** Loop-back recording seams (production omits this). */
export interface CiBlockOverrides {
	postCiGateRejectionFn?: typeof postCiGateRejection;
	upsertDeveloperPrFn?: typeof upsertDeveloperPr;
}

/**
 * Record a CI-gate block as a counted loop-back (issue #1829 AC1/AC2). A failed
 * counter write stops the pipeline: an uncounted loop-back would spin forever.
 * Returns the stop reason, or null when the loop-back was recorded.
 */
export async function recordCiBlock(
	runCtx: RunContext,
	note: string,
	iteration: number,
	overrides: CiBlockOverrides,
): Promise<string | null> {
	const { ctx, pi, config, issueNum, issueTitle, collector, stageState, worktreePath } = runCtx;
	const recorded = await recordCiLoopBack({
		issueNum,
		config,
		note,
		iteration,
		ctx,
		collector,
		port: runCtx.port,
		pr: {
			pi,
			issueTitle,
			worktreePath,
			worktreeBranch: runCtx.worktreeBranch,
			gateFailureHistory: stageState.gateFailureHistory,
		},
		overrides: {
			postRejection: overrides.postCiGateRejectionFn,
			upsertPr: overrides.upsertDeveloperPrFn,
		},
	});
	if (recorded.ok) return null;
	const stopReason = `Failed to record CI gate rejection: ${recorded.error}`;
	ctx.ui.notify(`${stopReason}. Stopping to avoid an unbounded loop.`, "error");
	collector?.push("handler", "error", stopReason);
	return stopReason;
}
