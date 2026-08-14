// ─── Pipeline Merge ──────────────────────────────────────────────
// PR readiness gate + post-pipeline merge conflict orchestration.
// Extracted from pipeline.ts to keep that file under 300 lines.
//
// Issue #1472: a rebase-conflict PR creation failure must not complete
// the pipeline. ensurePrReadyForDone() gates the Done transition on a
// PR that exists and is mergeable: on rebaseConflicts (no PR) or a
// dirty PR it resolves the conflicts (auto-merge → push, then a bounded
// developer dispatch + single createPrOnApproval retry) and re-polls.
// handlePostPipelineMerge() remains the post-Done backstop for races
// that slip past the gate.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	PrConflictInfo,
	PrCreationResult,
	PipelineAgentResult,
	SupervisorConfig,
	AgentRunner,
} from "../config/types.ts";
import { resolve as resolvePath } from "node:path";
import { generateBranchName } from "../agent/task.ts";
import { tryAutoMerge } from "../config/merge.ts";
import type { GitHubPort } from "../github/ports.ts";
import { runAgentSubprocess, DEFAULT_AGENT_TIMEOUT_MS } from "../agent/runner.ts";
import { parseAgentFile } from "../agent/loader.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { ErrorCollector } from "./error-collector.ts";
import { createPrOnApproval } from "./pr-creation.ts";

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

// ─── Conflict Resolution ──────────────────────────────────────────
// Shared auto-merge → push → developer-dispatch sequence used by both
// the pre-Done gate and the post-Done backstop. Returns whether the
// branch is resolved and whether the developer was dispatched.
async function resolveBranchConflicts(
	issueNum: number,
	branch: string,
	prNumber: number | undefined,
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath?: string,
	collector?: ErrorCollector,
	runner?: AgentRunner,
	rebaseConflicts?: string[],
): Promise<{ ok: boolean; devDispatched: boolean; note?: string }> {
	const log = getDebugLogger();
	const wt = worktreePath ?? resolvePath(ctx.cwd || process.cwd(), config.worktreeBase!, branch);

	ctx.ui.setStatus("supervisor", "Attempting auto-merge...");
	log.info("pipeline-merge", "Attempting auto-merge", { wt, branch });
	const mergeResult = await tryAutoMerge(wt, branch, config.defaultBranch!, config.remote!, pi);
	log.info("pipeline-merge", `Auto-merge result: success=${mergeResult.success}`, {
		conflictFiles: mergeResult.conflictFiles,
		message: mergeResult.message,
	});

	if (mergeResult.success) {
		try {
			log.info("pipeline-merge", "Pushing resolved merge");
			const pushResult = await pi.exec("git", ["push", config.remote!, branch], {
				cwd: wt,
				timeout: 30_000,
			});
			if (pushResult.code !== 0) {
				throw new Error(pushResult.stderr || pushResult.stdout || "git push failed");
			}
			log.info("pipeline-merge", "Merge resolved and pushed");
			ctx.ui.notify("Merge conflicts resolved and pushed!", "info");
			pi.sendMessage({
				customType: "supervisor",
				content: `## ✅ Merge Conflicts Resolved\n\nConflicts on ${branch} were resolved automatically and pushed.`,
				display: true,
			});
			return { ok: true, devDispatched: false };
		} catch (pushErr: unknown) {
			const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
			log.error("pipeline-merge", `Merge succeeded but push failed: ${msg}`);
			ctx.ui.notify(`Merge succeeded but push failed: ${msg}`, "error");
			collector?.push("merge", "error", `Merge succeeded but push failed: ${msg}`);
			return { ok: false, devDispatched: false, note: `Merge succeeded but push failed: ${msg}` };
		}
	}

	log.info("pipeline-merge", "Auto-merge failed, dispatching developer");
	ctx.ui.notify(
		`Auto-merge failed: ${mergeResult.message}. Dispatching developer to resolve...`,
		"warning",
	);

	const conflictFiles =
		mergeResult.conflictFiles.length > 0 ? mergeResult.conflictFiles : (rebaseConflicts ?? []);
	const prLabel = prNumber ? `PR #${prNumber}` : `issue #${issueNum}`;
	const devTask = [
		`## Task: Resolve Merge Conflicts`,
		``,
		`**Branch:** ${branch}`,
		`**Worktree:** ${wt}`,
		`**Base branch:** ${config.defaultBranch}`,
		`**Conflicted files:** ${conflictFiles.join(", ") || "(unknown)"}`,
		``,
		`### Steps`,
		`1. Enter worktree: \`cd ${wt}\``,
		`2. Fetch base: \`git fetch ${config.remote} ${config.defaultBranch}\``,
		`3. Merge base: \`git merge ${config.remote}/${config.defaultBranch}\``,
		`4. Resolve conflicts in the conflicted files`,
		`5. Stage resolved files: \`git add -A\``,
		`6. Commit merge: \`git commit -m "fix: resolve merge conflicts for ${prLabel}"\``,
		`7. Push: \`git push ${config.remote} ${branch}\``,
		``,
		`When done, output CONFLICTS_RESOLVED on its own line.`,
	].join("\n");

	// Dispatch developer via subprocess for consistent widget rendering
	log.info("pipeline-merge", "Dispatching developer for conflict resolution");
	try {
		const agentPath = resolvePath(wt, ".pi/extensions/supervisor/agents/developer.md");
		const { existsSync } = await import("node:fs");
		if (!existsSync(agentPath)) {
			throw new Error(`Agent file not found: ${agentPath}`);
		}
		const developerAgent = parseAgentFile(agentPath);

		const devTimeoutMs = config.agentTimeoutsMin?.developer
			? config.agentTimeoutsMin.developer * 60 * 1000
			: DEFAULT_AGENT_TIMEOUT_MS;

		const devResult = await (runner ?? runAgentSubprocess)(
			developerAgent,
			devTask,
			ctx,
			devTimeoutMs,
			wt,
			config.maxToolCalls,
			config.agentTokenBudget,
		);

		const devSuccess = devResult.success;

		log.info("pipeline-merge", `Developer conflict resolution: success=${devSuccess}`);

		pi.sendMessage({
			customType: "supervisor",
			content: `## Conflict Resolution: developer — ${devSuccess ? "SUCCESS" : "FAILED"}\n\n${devResult.summaryLine || ""}`,
			display: true,
			details: {
				eventType: "subagent-result",
				agentName: "developer",
				content: [{ type: "text", text: devResult.textOutput || "" }],
				details: {
					agentName: "developer",
					success: devSuccess,
					statusLabel: devSuccess ? "SUCCESS" : "FAILED",
					summaryLine: devResult.summaryLine || "",
				},
			},
		});

		if (devSuccess) {
			log.info("pipeline-merge", "Developer resolved conflicts");
			ctx.ui.notify("Developer resolved merge conflicts successfully!", "info");
			return { ok: true, devDispatched: true };
		}
		log.warn("pipeline-merge", "Developer failed to resolve conflicts");
		ctx.ui.notify("Developer failed to resolve conflicts. Manual intervention required.", "error");
		return {
			ok: false,
			devDispatched: true,
			note: "Developer failed to resolve conflicts. Manual intervention required.",
		};
	} catch (devErr: unknown) {
		const msg = devErr instanceof Error ? devErr.message : String(devErr);
		log.error("pipeline-merge", `Failed to dispatch developer: ${msg}`);
		ctx.ui.notify(`Failed to dispatch developer: ${msg}`, "error");
		return { ok: false, devDispatched: true, note: `Failed to dispatch developer: ${msg}` };
	}
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
interface PrGateDeps {
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
interface RoundState {
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
async function handleMissingPr(
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
async function handleSettledPrState(
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

export async function ensurePrReadyForDone(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentResults: PipelineAgentResult[],
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
	prCreationResult: PrCreationResult | undefined,
	collector?: ErrorCollector,
	port?: GitHubPort,
	runner?: AgentRunner,
	polls?: { attempts: number; backoffMs: number[] },
): Promise<PrGateVerdict> {
	const log = getDebugLogger();
	const branch = worktreeBranch ?? generateBranchName(issueNum, issueTitle, config.branchPrefix!);
	const mergePoll = polls ?? { attempts: 5, backoffMs: [2000, 4000, 8000, 16000, 32000] };
	const state: RoundState = { current: prCreationResult, retried: false };

	try {
		ctx.ui.setStatus("supervisor", "Verifying PR readiness before Done...");

		if (!port) {
			return {
				ok: false,
				prCreationResult: state.current,
				blockerNote: "GitHubPort not available — cannot verify PR readiness.",
			};
		}
		const deps: PrGateDeps = {
			pi,
			ctx,
			issueNum,
			issueTitle,
			config,
			agentResults,
			worktreePath,
			worktreeBranch,
			collector,
			runner,
			port,
		};

		for (let round = 0; round < 3; round++) {
			let info: PrConflictInfo | null;
			try {
				info = await port.listPullRequestsForBranch(branch, config.repo);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				log.warn("pipeline-merge", `PR readiness check failed: ${msg} — proceeding fail-open`, {
					branch,
				});
				// Fail-open: the post-Done backstop still catches stragglers.
				return { ok: true, prCreationResult: state.current };
			}

			const klass = classifyMergeability(info, state.current);
			if (klass.kind === "no-pr") {
				const outcome = await handleMissingPr(deps, state, branch, mergePoll, klass.mode);
				if ("verdict" in outcome) return outcome.verdict;
				continue;
			}

			// PR exists (or mergeability still computing) — poll until settled.
			// Non-no-pr kinds guarantee info is present.
			const settled = await awaitPrMergeability(port, branch, config.repo, mergePoll);
			if (!settled) {
				log.warn(
					"pipeline-merge",
					"Mergeability poll exhausted — proceeding fail-open (post-Done backstop covers)",
					{ prNumber: info!.number },
				);
				return { ok: true, prCreationResult: state.current };
			}
			const outcome = await handleSettledPrState(deps, state, branch, settled);
			if ("verdict" in outcome) return outcome.verdict;
		}

		return {
			ok: false,
			prCreationResult: state.current,
			blockerNote: "PR readiness verification did not settle — manual intervention required.",
		};
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
		// Clear developer widget in case it wasn't cleaned up
		ctx.ui.setWidget("agent-developer", undefined);
	}
}

/**
 * Handle post-pipeline merge conflict detection and resolution.
 * Called after the pipeline reaches "Done" status — backstop for races
 * that slip past the pre-Done gate.
 *
 * When `rebaseConflicts` is set and no PR exists (#1455 mode: PR creation
 * failed on rebase), the "No PR found" early return is skipped and the
 * conflicts are resolved directly.
 */
export async function handlePostPipelineMerge(
	issueNum: number,
	issueTitle: string,
	loopStatus: string,
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath?: string,
	collector?: ErrorCollector,
	_runner?: AgentRunner,
	port?: GitHubPort,
	rebaseConflicts?: string[],
): Promise<boolean> {
	const log = getDebugLogger();
	const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	log.info("pipeline-merge", `Post-pipeline merge check for #${issueNum}`, {
		branch,
		repo: config.repo,
		loopStatus,
	});

	let unresolvedConflicts = false;

	try {
		ctx.ui.setStatus("supervisor", "Checking PR for merge conflicts...");
		let conflictInfo: PrConflictInfo | null;
		try {
			if (!port) {
				ctx.ui.notify("GitHubPort not available — skipping conflict check", "error");
				return false;
			}
			conflictInfo = await port.listPullRequestsForBranch(branch, config.repo);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`PR conflict check failed: ${msg}`, "error");
			collector?.push("merge", "error", `PR conflict check failed: ${msg}`);
			return false;
		}

		const rebaseOnly = !conflictInfo && (rebaseConflicts?.length ?? 0) > 0;
		if (!conflictInfo && !rebaseOnly) {
			log.info("pipeline-merge", "No PR found for branch — skipping");
			ctx.ui.notify("No PR found for this branch — skipping conflict check.", "info");
			return false;
		}

		if (rebaseOnly) {
			// #1455 mode: PR creation failed with rebase conflicts, no PR exists.
			unresolvedConflicts = true;
			log.warn("pipeline-merge", "No PR found but rebase conflicts reported — resolving", {
				rebaseConflicts,
			});
			ctx.ui.notify(
				`PR creation failed with rebase conflicts in ${rebaseConflicts!.length} file(s) — attempting resolution.`,
				"warning",
			);
			const shouldFix = ctx.hasUI
				? await ctx.ui.confirm(
						"Merge Conflict Detected",
						`PR creation for ${branch} failed with rebase conflicts in ${rebaseConflicts!.join(", ")}. Should I fix them?`,
					)
				: true;
			if (shouldFix) {
				const resolved = await resolveBranchConflicts(
					issueNum,
					branch,
					undefined,
					config,
					pi,
					ctx,
					worktreePath,
					collector,
					_runner,
					rebaseConflicts,
				);
				if (resolved.ok) unresolvedConflicts = false;
			}
			return unresolvedConflicts;
		}

		if (conflictInfo!.hasConflict) {
			unresolvedConflicts = true;
			log.warn("pipeline-merge", `PR #${conflictInfo!.number} has conflicts`, {
				mergeable: conflictInfo!.mergeable,
				mergeStateStatus: conflictInfo!.mergeStateStatus,
				baseRef: conflictInfo!.baseRefName,
				headRef: conflictInfo!.headRefName,
			});
			ctx.ui.notify(
				`PR #${conflictInfo!.number} has merge conflicts! (mergeable: ${conflictInfo!.mergeable}, state: ${conflictInfo!.mergeStateStatus})`,
				"warning",
			);

			// Mode adaptation: when hasUI is false (print/json mode),
			// default to true (attempt auto-merge) without prompting.
			const shouldFix = ctx.hasUI
				? await ctx.ui.confirm(
						"Merge Conflict Detected",
						`PR #${conflictInfo!.number} (${branch}) has merge conflicts with ${conflictInfo!.baseRefName}. Should I fix them?`,
					)
				: true;

			if (shouldFix) {
				const resolved = await resolveBranchConflicts(
					issueNum,
					branch,
					conflictInfo!.number,
					config,
					pi,
					ctx,
					worktreePath,
					collector,
					_runner,
				);
				if (resolved.ok) unresolvedConflicts = false;
			}
		} else {
			log.info("pipeline-merge", `PR #${conflictInfo!.number} has no conflicts`);
			ctx.ui.notify(
				`PR #${conflictInfo!.number} has no merge conflicts (mergeable: ${conflictInfo!.mergeable}).`,
				"info",
			);
			unresolvedConflicts = false;
		}
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
		// Clear developer widget in case it wasn't cleaned up
		ctx.ui.setWidget("agent-developer", undefined);
	}
	return unresolvedConflicts;
}
