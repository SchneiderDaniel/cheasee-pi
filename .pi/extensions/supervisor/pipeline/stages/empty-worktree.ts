// ─── Pipeline Stages — empty-worktree classification (Bug #1343) ─
// Signal gathering (hasCommits / changeOnMain / openPrs) and 3-way
// dispatch (loop / close / leaveOpenForPr), extracted from runAgentLoop
// (S104 ceiling, issue #1533). Policy stays pure in
// pipeline/empty-worktree-policy.ts; git/port/notify side effects live
// here. Control flow is signalled via EmptyWorktreeOutcome — this module
// never break/continues the caller's loop.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import type { ClosingPrRef, GitHubPort } from "../../github/ports.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { ExecFn } from "../helpers.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import {
	classifyEmptyWorktree,
	buildResolvedByComment,
	buildLeaveOpenForPrComment,
} from "../empty-worktree-policy.ts";
import type { EmptyWorktreeAction, EmptyWorktreeSignals } from "../empty-worktree-policy.ts";
import { hasBranchCommits, gitCherryContains, fetchResolvedByInfo } from "./git-ops.ts";

/** Control-flow signal for the dispatch skeleton (no break/continue here). */
export type EmptyWorktreeOutcome = { stop: true; stopReason: string } | { stop: false };

/**
 * Bug #1343 3-way empty-worktree handling. Guarded by the skeleton
 * (agentName === "developer" && nextStatus === "Audit" && worktreePath
 * && result.success). Gathers signals, classifies, dispatches.
 */
export async function handleEmptyWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: SupervisorConfig,
	port: GitHubPort,
	collector: ErrorCollector | undefined,
	issueNum: number,
	worktreePath: string,
	worktreeBranch: string | undefined,
): Promise<EmptyWorktreeOutcome> {
	const execFn = ((cmd: string, args: string[], opts?: Record<string, unknown>) =>
		pi.exec(cmd, args, opts)) as ExecFn;
	const baseBranch = config.defaultBranch || "main";
	const headBranch = worktreeBranch || config.branchPrefix! + issueNum;

	const hasCommits = await hasBranchCommits(execFn, worktreePath, headBranch, baseBranch);
	if (hasCommits) {
		return { stop: false };
	}

	getDebugLogger().info("handler", "No commits from developer — classifying empty worktree", {
		worktreeBranch: headBranch,
		defaultBranch: baseBranch,
	});

	// 1. changeOnMain: gitCherryContains primary, git diff --quiet fallback
	let changeOnMain = await gatherChangeOnMain(execFn, worktreePath, baseBranch);

	// 2. openPrs: PRs referencing this issue
	let openPrs: ClosingPrRef[] = [];
	try {
		openPrs = await gatherOpenPrs(port, issueNum, config.repo);
	} catch (prErr: unknown) {
		const prMsg = prErr instanceof Error ? prErr.message : String(prErr);
		getDebugLogger().warn("handler", `getClosingPrsForIssue failed: ${prMsg}`);
		// Fail-open: on API error, force changeOnMain=false so we loop
		// (case 1) instead of closing (case 2) — matching the test plan.
		changeOnMain = false;
	}

	// 3. Classify and dispatch
	const signals: EmptyWorktreeSignals = { hasCommits: false, changeOnMain, openPrs };
	const action = classifyEmptyWorktree(signals);

	getDebugLogger().info("handler", "Empty worktree classification", {
		signals: { hasCommits: false, changeOnMain, openPrCount: openPrs.length },
		actionKind: action?.kind,
	});

	return dispatchEmptyWorktreeAction(
		action,
		ctx,
		port,
		collector,
		issueNum,
		config,
		execFn,
		worktreePath,
		baseBranch,
	);
}

/**
 * changeOnMain: primary gitCherryContains ("HEAD" vs base), fallback
 * git diff --quiet for clean-worktree detection. Fail-open on git
 * failure: assume changes NOT on main (safe: loop back).
 */
export async function gatherChangeOnMain(
	execFn: ExecFn,
	worktreePath: string,
	baseBranch: string,
): Promise<boolean> {
	try {
		const changeOnMain = await gitCherryContains(execFn, worktreePath, baseBranch, "HEAD");
		if (changeOnMain) {
			return true;
		}
		// gitCherryContains returned false (incl. empty) — clean-worktree check.
		const diffResult = await execFn("git", ["diff", "--quiet"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		return diffResult.code === 0;
	} catch {
		// git commands failed — assume changes not on main (safe: loop back)
		return false;
	}
}

/**
 * openPrs: PRs referencing this issue. Throws on API failure — the
 * caller forces changeOnMain=false (fail-open loop-back) and warns.
 */
export async function gatherOpenPrs(
	port: GitHubPort,
	issueNum: number,
	repo: string,
): Promise<ClosingPrRef[]> {
	return await port.getClosingPrsForIssue(issueNum, repo);
}

/**
 * Dispatch the classifier's action. The 3 break paths of the former
 * loop collapse to { stop: true } with the stop reason; classifier null
 * falls through ({ stop: false }) to the auditor as safe default.
 */
export async function dispatchEmptyWorktreeAction(
	action: EmptyWorktreeAction | null,
	ctx: ExtensionCommandContext,
	port: GitHubPort,
	collector: ErrorCollector | undefined,
	issueNum: number,
	config: SupervisorConfig,
	execFn: ExecFn,
	worktreePath: string,
	baseBranch: string,
): Promise<EmptyWorktreeOutcome> {
	if (!action) {
		// classifier returned null — shouldn't happen with hasCommits=false
		// but fall through to auditor as safe default
		getDebugLogger().warn(
			"handler",
			"Empty worktree classifier returned null — proceeding to auditor",
		);
		return { stop: false };
	}

	if (action.kind === "loop") {
		// Case 1: No commits, changes absent on main → loop back to Implementation
		ctx.ui.notify(
			`Developer produced no commits and changes not on main. Looping back to Implementation: ${action.reason}`,
			"warning",
		);
		getDebugLogger().warn("handler", "Empty worktree — looping to Implementation", {
			reason: action.reason,
		});
		// Don't close issue, don't post comment — just stop the pipeline so it
		// can be restarted with fresh developer dispatch
		return { stop: true, stopReason: action.reason };
	}

	if (action.kind === "close") {
		// Case 2: No commits, changes already on main → close with named resolution
		// Fetch the actual resolving commit SHA from the default branch.
		// This ensures the close comment names the real commit, not a placeholder.
		const stopReason = `Changes already on main — closing issue`;
		const resolvedBy = await fetchResolvedByInfo(
			execFn,
			worktreePath,
			baseBranch,
			port,
			issueNum,
			config.repo,
		);
		ctx.ui.notify("Required changes already present on main. Closing issue.", "info");
		getDebugLogger().info("handler", "Empty worktree — closing with resolution", {
			resolvedBy,
		});
		try {
			const commentBody = buildResolvedByComment(resolvedBy);
			await port.postIssueComment(issueNum, config.repo, commentBody);
			await port.closeIssue(issueNum, config.repo);
			ctx.ui.notify(`Issue #${issueNum} closed — already resolved on main`, "info");
		} catch (closeErr: unknown) {
			const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
			ctx.ui.notify(`Failed to close issue: ${closeMsg}`, "warning");
			collector?.push("handler", "warn", `Failed to close issue #${issueNum}: ${closeMsg}`);
		}
		return { stop: true, stopReason };
	}

	// action.kind === "leaveOpenForPr"
	// Case 3: No commits, open PR exists → leave open for PR review
	const stopReason = `Open PR #${action.prNumber} targets this issue — leaving open`;
	ctx.ui.notify(
		`Open PR #${action.prNumber} (${action.branch}) targets this issue — leaving open.`,
		"info",
	);
	getDebugLogger().info("handler", "Empty worktree — leaving open for PR", {
		prNumber: action.prNumber,
		branch: action.branch,
	});
	try {
		const commentBody = buildLeaveOpenForPrComment(action.prNumber, action.branch);
		await port.postIssueComment(issueNum, config.repo, commentBody);
		// Do NOT close the issue
		ctx.ui.notify(`Posted comment linking PR #${action.prNumber} on issue #${issueNum}`, "info");
	} catch (commentErr: unknown) {
		const commentMsg = commentErr instanceof Error ? commentErr.message : String(commentErr);
		ctx.ui.notify(`Failed to post comment: ${commentMsg}`, "warning");
		collector?.push("handler", "warn", `Failed to post PR link comment: ${commentMsg}`);
	}
	return { stop: true, stopReason };
}
