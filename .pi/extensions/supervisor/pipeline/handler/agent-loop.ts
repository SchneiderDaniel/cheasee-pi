// ─── Pipeline Handler Package: Agent Loop ────────────────────────
// The MAX_PIPELINE_LOOPS stage machine (issue #1395 split of handler.ts).
// Iterates Backlog → Research → Architecture → TestDesign → Implementation
// → Audit → Done, incl. PR creation on approval, budget-exceeded
// degradation, empty-worktree classification and pre-transition hooks.
//
// ponytail: this is the one intentionally-long function in the package —
// a linear state machine where each iteration is a conceptually simple
// sequence of guarded steps (kernel style permits long-but-simple loops).
// Split per-step only if the loop ever gains branching complexity.

import type { AgentOutput } from "../../config/types.ts";
import type { ClosingPrRef } from "../../github/ports.ts";
import type { EmptyWorktreeSignals } from "../empty-worktree-policy.ts";
import { resolveTimeoutMs } from "../../config/config.ts";
import { buildAgentTask, summarizeComments } from "../../agent/task.ts";
import {
	classifyEmptyWorktree,
	buildResolvedByComment,
	buildLeaveOpenForPrComment,
} from "../empty-worktree-policy.ts";
import { executeAgent } from "../execute-agent.ts";
import { tryRebaseOntoBase } from "../rebase.ts";
import {
	WORKFLOW,
	computeAuditScoreFromFindings,
	getActiveAuditDimensions,
	evaluateAuditScoreGate,
} from "../../config/workflow.ts";
import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "../../agent/output.ts";
import { runTscAndLspAudit } from "../audit/index.ts";
import { validateAgentResult } from "../output.ts";
import { writeCheckpointFile } from "../state-checkpoint.ts";
import { createPrOnApproval } from "../pr-creation.ts";
import {
	MAX_PIPELINE_LOOPS,
	handleBacklogTransition,
	resolveAgentName,
	isRejectionLimitReached,
	calculateNextStatus,
	trackAuditScore,
	applyStatusTransition,
	buildAgentResultEntry,
	handlePostAgentSuccess,
	shouldSkipResearcher,
	inferForwardStatus,
	hasBranchCommits,
	gitCherryContains,
	buildDuplicateCodeContext,
	applyGateFailureContext,
	buildDeadCodeContext,
	buildVulnContext,
	type GateRejected,
} from "../stages/index.ts";
import { fetchFreshIssueData, loadAgentFile as loadAgentFileHelper } from "../helpers.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { fetchResolvedByInfo, type RunContext } from "./shared.ts";
import { runPrReadinessGate, blockPipelineOnPrGate } from "./pr-gates.ts";

/**
 * Runs the pipeline loop until a terminal status, stop reason or budget
 * exhaustion. Mutates runCtx in place (agentResults, stageState, loopStatus,
 * stopReason, prCreationResult) — the post-pipeline phase reads the final
 * state from the same context.
 */
export async function runAgentLoop(runCtx: RunContext): Promise<void> {
	const {
		ctx,
		pi,
		config,
		issueNum,
		issueTitle,
		worktreePath,
		worktreeBranch,
		systemPromptOptions,
		exec,
		notify,
		collector,
		port,
		stageState,
		agentResults,
		issueData,
		loopItem,
		fields,
		statusField,
		projectId,
	} = runCtx;
	let loopStatus = runCtx.loopStatus;
	let stopReason = runCtx.stopReason;
	let prCreationResult = runCtx.prCreationResult;

	for (let i = 0; i < MAX_PIPELINE_LOOPS; i++) {
		ctx.ui.setStatus("supervisor", `Status: ${loopStatus}`);
		ctx.ui.notify(`Issue #${issueNum}: "${issueTitle}" — Status: ${loopStatus}`, "info");
		getDebugLogger().info("handler", `Pipeline iteration ${i + 1}`, {
			loopStatus,
			iteration: i,
		});

		const step = WORKFLOW.find((s) => s.status.toLowerCase() === loopStatus.toLowerCase());
		if (!step) {
			stopReason = `No workflow step for status '${loopStatus}'`;
			ctx.ui.notify(
				`No workflow step for status '${loopStatus}'. Available: ${WORKFLOW.map((s) => s.status).join(", ")}`,
				"error",
			);
			getDebugLogger().error("handler", "No workflow step", { loopStatus });
			break;
		}

		// Built-in: Backlog → Research
		if (step.builtIn === "backlog") {
			loopStatus = await handleBacklogTransition(
				port,
				fields,
				statusField.id,
				loopItem.id,
				projectId,
			);
			ctx.ui.notify(`Issue #${issueNum} moved: Backlog → Research`, "info");
			getDebugLogger().info("handler", "Backlog → Research");
			continue;
		}

		// Built-in: Done
		if (step.builtIn === "done") {
			ctx.ui.notify(`Issue #${issueNum} is Done. Pipeline complete.`, "info");
			getDebugLogger().info("handler", "Pipeline complete — Done status");
			break;
		}

		// Resolve agent for this status
		const agentName = resolveAgentName(loopStatus, config);
		if (!agentName) {
			stopReason = `No agent for status '${loopStatus}'`;
			ctx.ui.notify(`No agent for status '${loopStatus}'`, "error");
			getDebugLogger().error("handler", "No agent for status", { loopStatus });
			break;
		}

		const loopFilteredData = await fetchFreshIssueData(
			exec,
			config,
			issueNum,
			issueData,
			collector,
		);

		// Rejection limit check
		if (isRejectionLimitReached(loopFilteredData.comments, step.maxRejections)) {
			stopReason = `Rejection limit reached (${step.maxRejections})`;
			ctx.ui.notify(
				`Issue #${issueNum} rejected ${step.maxRejections} times. Human intervention required.`,
				"error",
			);
			getDebugLogger().warn("handler", "Rejection limit reached", {
				maxRejections: step.maxRejections,
			});
			break;
		}

		// Deduplication gate: skip researcher if findings already exist
		if (agentName === "researcher" && shouldSkipResearcher(loopStatus, loopFilteredData)) {
			ctx.ui.notify(
				`Issue #${issueNum} already has research findings — skipping researcher`,
				"info",
			);
			getDebugLogger().info("handler", "Skipping researcher — findings exist");
			stageState.researcherSkipped = true;
			// Find the next forward status for the researcher step
			const nextStatus = inferForwardStatus(step);
			if (nextStatus) {
				loopStatus = await applyStatusTransition(
					port,
					loopItem.id,
					projectId,
					fields,
					statusField.id,
					nextStatus,
				);
				ctx.ui.notify(
					`Issue #${issueNum} moved: Research → ${nextStatus} (deduplication gate)`,
					"info",
				);
				getDebugLogger().info("handler", `Research → ${nextStatus} (dedup gate)`);
				continue;
			}
		}

		// Write checkpoint before auditor dispatch (heavy/long-running operation)
		if (agentName === "auditor" && worktreePath && worktreeBranch) {
			const checkpointResult = writeCheckpointFile(ctx.cwd, {
				issueNum,
				checkpoint: "pre-auditor",
				worktreePath,
				worktreeBranch,
				startedAt: new Date().toISOString(),
			});
			if (!checkpointResult.ok) {
				ctx.ui.notify(
					`Warning: Failed to write pre-auditor checkpoint: ${checkpointResult.error}`,
					"warning",
				);
				getDebugLogger().warn("handler", "Failed to write pre-auditor checkpoint", {
					error: checkpointResult.error,
				});
			}
		}

		// Load agent
		const agent = await loadAgentFileHelper(exec, notify, ctx.cwd, agentName, collector);
		if (!agent) {
			stopReason = `Agent file not found: ${agentName}`;
			getDebugLogger().error("handler", "Agent file not found", { agentName });
			break;
		}

		ctx.ui.setStatus("supervisor", `Running ${agent.config.name}...`);
		ctx.ui.notify(`Dispatching ${agent.config.name}...`, "info");
		const timeoutMs = resolveTimeoutMs(agentName, config.agentTimeoutsMin!);

		// Build task
		const dupContext: string | undefined =
			agentName === "auditor"
				? (buildDuplicateCodeContext(stageState.duplicateCodeResult) ?? undefined)
				: undefined;
		// Extract research findings from issue comments for architect
		const researchFindings: string | undefined =
			agentName === "architect"
				? loopFilteredData.comments
						.map((c) => c.body)
						.find((body) => /##\s*Research\s*Findings/i.test(body))
				: undefined;
		// Extract latest audit rejection comment for developer feedback loop
		// When audit rejects and pipeline loops back to Implementation, the developer
		// needs to see EXACTLY what the auditor found wrong — not just a generic
		// list of trusted comments where audit feedback is buried.
		const auditFeedback: string | undefined =
			agentName === "developer"
				? (() => {
						// Find the latest comment containing "## Audit Rejected"
						for (let i = loopFilteredData.comments.length - 1; i >= 0; i--) {
							const body = loopFilteredData.comments[i]?.body || "";
							if (/##\s*Audit\s*Rejected/i.test(body)) {
								return body;
							}
						}
						return undefined;
					})()
				: undefined;
		// Build dead code context for auditor
		const deadContext: string | undefined =
			agentName === "auditor"
				? (buildDeadCodeContext(stageState.deadCodeResult) ?? undefined)
				: undefined;
		// Build vuln context for auditor
		const vulnContext: string | undefined =
			agentName === "auditor" ? (buildVulnContext(stageState.vulnResult) ?? undefined) : undefined;
		// Pre-Implementation rebase (issue #1473): refresh the worktree onto the
		// latest default branch before every developer dispatch (incl. Audit→
		// Implementation loop-backs), so same-family PRs landing mid-pipeline
		// don't produce late PR-creation conflicts. Conflicts are resolved by
		// the developer with full context (mergeFallback:false — the fallback
		// merge commit would pollute hasBranchCommits). Fail-open on network
		// failure: the end-rebase at PR creation remains the backstop.
		const rebaseConflictContext =
			agentName === "developer" && worktreePath && worktreeBranch
				? await refreshWorktreeBeforeImplementation(runCtx, worktreePath)
				: undefined;

		const task = buildAgentTask(
			agentName,
			issueNum,
			config.repo,
			issueTitle,
			loopFilteredData,
			config.defaultBranch!,
			config.remote!,
			config.worktreeBase!,
			config.branchPrefix!,
			ctx.cwd, // mainRepoPrefix
			worktreePath,
			worktreeBranch,
			summarizeComments(loopFilteredData.comments),
			dupContext,
			researchFindings,
			auditFeedback,
			deadContext,
			vulnContext,

			stageState.gateFailureContext,
			systemPromptOptions,
			rebaseConflictContext,
		);

		getDebugLogger().info("handler", `Dispatching agent ${agentName}`, {
			model: agent.config.model,
			timeoutMs,
			taskLen: task.length,
			cwdOverride: worktreePath,
		});

		// Execute agent (initial attempt)
		let usedRetry = false;
		const { result: initialResult } = await executeAgent(
			agent,
			task,
			ctx,
			pi,
			timeoutMs,
			worktreePath,
			config.maxToolCalls,
			config.agentTokenBudget,
			issueTitle,
			runCtx._runner,
		);
		let result = initialResult;
		validateAgentResult(result);

		// Retry block: budget exceeded is NOT retryable (Neel Mishra taxonomy)
		if (result.budgetExceeded) {
			getDebugLogger().info("handler", `Agent ${agentName} exceeded budget — retry skipped`, {
				budgetExceeded: true,
			});
		} else if (!result.success) {
			getDebugLogger().info("handler", `Agent ${agentName} failed — retrying once`, {
				success: false,
			});
			const { result: retryResult } = await executeAgent(
				agent,
				task,
				ctx,
				pi,
				timeoutMs,
				worktreePath,
				config.maxToolCalls,
				config.agentTokenBudget,
				issueTitle,
				runCtx._runner,
			);
			validateAgentResult(retryResult);
			usedRetry = true;
			// Issue #1495: push the validated failed run (FAILED row, own stats) before the retry row
			agentResults.push(buildAgentResultEntry(result, false, agent.config.model));
			result = retryResult;
		}

		getDebugLogger().info("handler", `Agent ${agentName} completed`, {
			success: result.success,
			usedRetry,
			durationMs: result.durationMs,
			toolCount: result.toolCount,
			tokenCount: result.tokenCount,
			budgetExceeded: result.budgetExceeded,
			summary: result.summaryLine?.slice(0, 200),
		});

		agentResults.push(buildAgentResultEntry(result, usedRetry, agent.config.model));

		// Debug tracing: agentResults after push (R3 requirement)
		getDebugLogger().info("handler", "agentResults after push", {
			length: agentResults.length,
			lastAgent: agentResults[agentResults.length - 1]?.agentName,
			iteration: i,
		});

		// Track audit score
		const auditInfo = trackAuditScore(result.textOnly, stageState, new Set(result.toolCalls ?? []));
		if (auditInfo) {
			ctx.ui.notify(
				`Audit #${auditInfo.cycleCount} score: ${auditInfo.score.passing}/${auditInfo.score.total}${auditInfo.trend ? ` (${auditInfo.trend})` : ""}`,
				"info",
			);
			getDebugLogger().info("handler", "Audit score tracked", {
				cycleCount: auditInfo.cycleCount,
				score: auditInfo.score,
				trend: auditInfo.trend,
			});
		}

		// Pre-compute audit score gate decision for auditor
		// This runs BEFORE handlePostAgentSuccess so the gate rejection
		// comment can replace the normal approval comment.
		let gateRejected: GateRejected | undefined;
		if (agentName === "auditor" && result.success && result.textOutput) {
			const parseResult = parseAgentOutput(result.textOutput, new Set(result.toolCalls ?? []));
			if (isAgentOutputSuccess(parseResult)) {
				const output = parseResult as AgentOutput;
				if (output.action === "APPROVED" && output.findings && output.findings.length > 0) {
					const dimensions = getActiveAuditDimensions(stageState.researcherSkipped);
					const score = computeAuditScoreFromFindings(output.findings, dimensions);
					const gateResult = evaluateAuditScoreGate(score, config.auditScoreThreshold ?? 0.75);
					if (!gateResult.passes) {
						gateRejected = {
							score,
							required: gateResult.required,
							total: dimensions.length,
						};
						ctx.ui.notify(
							`Audit score gate rejected: ${score.passing}/${dimensions.length} < ${gateResult.required}/${dimensions.length}`,
							"warning",
						);
					}
				}
			}
		}

		// Agent result is already sent by executeAgent with eventType: "subagent-result".

		// Post-processing — pass pre-computed gateRejected so auditor
		// comment posting can show gate rejection instead of approval
		if (result.success) {
			const continuePipeline = await handlePostAgentSuccess(
				pi,
				ctx,
				result,
				agentName,
				issueNum,
				config,
				loopFilteredData,
				worktreePath,
				worktreeBranch,
				issueTitle,
				collector,
				gateRejected,
				notify,
				port,
			);
			if (!continuePipeline) {
				stopReason = `commitAndPush failed for ${agentName}`;
				getDebugLogger().error("handler", "commitAndPush failed", { agentName });
				break;
			}
		}

		// Determine next status — pass result.success so inferForwardStatus
		// is skipped on agent failure (Bug #643 fix).
		// hadExplicitMarker tracks whether the status came from agent output
		// (structured JSON or text marker) vs. pipeline inference (Bug #711 fix).
		// For auditor, pass audit context with researcherSkipped and scoreThreshold
		// so the audit score gate (Bug #648 fix) can evaluate independently.
		// Note: gateRejected may already be computed above; calculateNextStatus
		// re-computes it deterministically — this is fine (<1ms overhead).
		const auditContext =
			agentName === "auditor"
				? {
						researcherSkipped: stageState.researcherSkipped,
						scoreThreshold: config.auditScoreThreshold ?? 0.75,
					}
				: undefined;
		const {
			status: nextStatus,
			stopReason: nsStop,
			hadExplicitMarker = false,
		} = calculateNextStatus(
			agentName,
			result.textOutput,
			result.textOnly,
			result.success,
			auditContext,
			new Set(result.toolCalls ?? []),
		);

		getDebugLogger().info("handler", "Next status determined", {
			nextStatus,
			stopReason: nsStop,
		});

		// Bug #1343: 3-way empty worktree classification.
		// When developer produced no commits, determine if we should:
		//   1. Loop back to Implementation (changes absent on main)
		//   2. Close with named resolution (changes already on main)
		//   3. Leave open for PR review (open PR exists for this issue)
		if (agentName === "developer" && nextStatus === "Audit" && worktreePath && result.success) {
			const execFn = (cmd: string, args: string[], opts?: Record<string, unknown>) =>
				pi.exec(cmd, args, opts);
			const baseBranch = config.defaultBranch || "main";
			const headBranch = worktreeBranch || config.branchPrefix! + issueNum;

			const hasCommits = await hasBranchCommits(execFn, worktreePath, headBranch, baseBranch);

			if (!hasCommits) {
				getDebugLogger().info("handler", "No commits from developer — classifying empty worktree", {
					worktreeBranch: headBranch,
					defaultBranch: baseBranch,
				});

				// Fetch signals for empty worktree classification
				// 1. changeOnMain: use gitCherryContains to detect if changes are
				//    already upstream (primary), fall back to git diff --quiet for
				//    clean-worktree detection (secondary).
				let changeOnMain = false;
				try {
					// Primary: gitCherryContains checks if worktree HEAD commits are
					// equivalent to changes already applied on the default branch.
					// In the hasCommits=false case (no unique commits), this returns
					// false (empty output) — we fall through to the secondary check.
					changeOnMain = await gitCherryContains(execFn, worktreePath, baseBranch, "HEAD");
					// Fallback: if gitCherryContains returned false (incl. empty),
					// use git diff --quiet to check if the worktree is clean.
					// A clean worktree with no unique commits means the developer
					// saw no work to do — changes are already on main.
					if (!changeOnMain) {
						const diffResult = await execFn("git", ["diff", "--quiet"], {
							cwd: worktreePath,
							timeout: 10_000,
						});
						changeOnMain = diffResult.code === 0;
					}
				} catch {
					// If git commands fail, assume changes not on main (safe: loop back)
					changeOnMain = false;
				}

				// 2. openPrs: check for PRs referencing this issue
				let openPrs: ClosingPrRef[] = [];
				try {
					openPrs = await port.getClosingPrsForIssue(issueNum, config.repo);
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

				if (!action) {
					// classifier returned null — shouldn't happen with hasCommits=false
					// but fall through to auditor as safe default
					getDebugLogger().warn(
						"handler",
						"Empty worktree classifier returned null — proceeding to auditor",
					);
				} else if (action.kind === "loop") {
					// Case 1: No commits, changes absent on main → loop back to Implementation
					stopReason = action.reason;
					ctx.ui.notify(
						`Developer produced no commits and changes not on main. Looping back to Implementation: ${action.reason}`,
						"warning",
					);
					getDebugLogger().warn("handler", "Empty worktree — looping to Implementation", {
						reason: action.reason,
					});
					// Don't close issue, don't post comment — just stop the pipeline so it
					// can be restarted with fresh developer dispatch
					break;
				} else if (action.kind === "close") {
					// Case 2: No commits, changes already on main → close with named resolution
					// Fetch the actual resolving commit SHA from the default branch.
					// This ensures the close comment names the real commit, not a placeholder.
					stopReason = `Changes already on main — closing issue`;
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
					break;
				} else if (action.kind === "leaveOpenForPr") {
					// Case 3: No commits, open PR exists → leave open for PR review
					stopReason = `Open PR #${action.prNumber} targets this issue — leaving open`;
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
						ctx.ui.notify(
							`Posted comment linking PR #${action.prNumber} on issue #${issueNum}`,
							"info",
						);
					} catch (commentErr: unknown) {
						const commentMsg =
							commentErr instanceof Error ? commentErr.message : String(commentErr);
						ctx.ui.notify(`Failed to post comment: ${commentMsg}`, "warning");
						collector?.push("handler", "warn", `Failed to post PR link comment: ${commentMsg}`);
					}
					break;
				}
			}
		}

		// PR creation on audit approval — capture result for completion summary
		// (Bug 2, Bug 6 fix: propagate PR creation result to caller)
		if (agentName === "auditor" && result.success && nextStatus === "Done") {
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
			prCreationResult = await createPrOnApproval(
				pi,
				ctx,
				issueNum,
				issueTitle,
				config,
				agentResults,
				worktreePath,
				worktreeBranch,
				collector,
				stageState.gateFailureHistory,
				undefined,
				port,
			);

			// Pre-Done readiness gate (issue #1472): a rebase-conflict PR
			// creation failure must NOT complete the pipeline. The gate
			// resolves conflicts (auto-merge → developer dispatch → bounded
			// 1× retry) and re-polls; on blocked, the issue is moved to a
			// non-Done status with a blocker comment instead of Done.
			const gate = await runPrReadinessGate(
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
				runCtx._runner,
			);
			prCreationResult = gate.prCreationResult;
			if (gate.blocked) {
				stopReason = await blockPipelineOnPrGate(
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
					gate.blockerNote ?? "PR not ready for Done — manual intervention required.",
				);
				// The issue now sits in a non-Done status — the post-pipeline
				// phase must not treat it as complete (never COMPLETED w/o PR).
				loopStatus = "Implementation";
				break;
			}
		}

		if (result.budgetExceeded) {
			// Graceful degradation: researcher stops researching, pipeline continues
			if (agentName === "researcher") {
				// When result.success is also true, handlePostAgentSuccess already posted
				// a combined comment (partial findings + "stopped early" header).
				// Skip separate comment here to avoid duplication.
				if (!result.success) {
					const budgetExceededMsg = `## Research Findings — Research stopped early: agent exceeded token budget (${result.tokenCount} tokens used). Pipeline continues without full research findings.`;
					try {
						await port.postIssueComment(issueNum, config.repo, budgetExceededMsg);
						ctx.ui.notify(`Posted researcher degradation notice on issue #${issueNum}`, "info");
					} catch (commentErr: unknown) {
						collector?.push(
							"handler",
							"warn",
							`Failed to post researcher degradation notice: ${
								commentErr instanceof Error ? commentErr.message : String(commentErr)
							}`,
						);
					}
				}
				const nextStatus = inferForwardStatus(step);
				if (nextStatus) {
					loopStatus = await applyStatusTransition(
						port,
						loopItem.id,
						projectId,
						fields,
						statusField.id,
						nextStatus,
					);
					ctx.ui.notify(
						`Issue #${issueNum} moved: Research → ${nextStatus} (researcher budget exceeded — graceful degradation)`,
						"info",
					);
					getDebugLogger().info("handler", `Research → ${nextStatus} (budget exceeded)`);
					continue;
				}
			}
			stopReason = `Agent ${result.agentName} exceeded budget (${result.toolCount} tools, ${result.tokenCount} tokens)`;
			getDebugLogger().warn("handler", "Budget exceeded", {
				agentName: result.agentName,
				toolCount: result.toolCount,
				tokenCount: result.tokenCount,
			});
			break;
		}

		// Bug #711: Replace status-based failure guard with explicit-marker check.
		// Old guard: !result.success && nextStatus !== "Audit" — only worked for auditor
		// step because developer's only forward marker IS "Audit".
		// New guard: if agent failed AND no explicit marker in its output → stop.
		// Explicit marker means structured JSON action or text marker match,
		// NOT inferForwardStatus (which is pipeline inference, not agent output).
		// This prevents the crash-loop: developer crashes (0 tokens, 0 tools),
		// inferForwardStatus returns "Audit", hadExplicitMarker=false → stop.
		if (!result.success && !hadExplicitMarker) {
			stopReason = `Agent ${agent.config.name} failed — no explicit completion marker in output`;
			ctx.ui.notify(`Agent ${agent.config.name} failed. Pipeline stops.`, "warning");
			getDebugLogger().error("handler", "Agent failed, pipeline stopping (no explicit marker)", {
				agentName: agent.config.name,
				nextStatus,
			});
			break;
		}

		if (!nextStatus) {
			stopReason = nsStop || `Agent ${agent.config.name} output unclear`;
			ctx.ui.notify(stopReason, "warning");
			getDebugLogger().warn("handler", "No next status from agent output", {
				agentName: agent.config.name,
				stopReason,
			});
			break;
		}

		if (step.canLoopBackTo?.includes(nextStatus)) {
			ctx.ui.notify(`Feedback loop: ${loopStatus} → ${nextStatus}`, "info");
			getDebugLogger().info("handler", "Feedback loop", { from: loopStatus, to: nextStatus });
		}

		// Pre-transition hooks (CI, TSC, LSP, duplicate code)
		let effectiveNextStatus = nextStatus;
		if (step.hooks?.some((h) => ["ci", "tsc", "lsp", "dup", "trace"].includes(h))) {
			try {
				getDebugLogger().info("handler", "Running pre-transition hooks", {
					hooks: step.hooks,
				});
				const auditResult = await runTscAndLspAudit(
					issueNum,
					issueTitle,
					config,
					agentName,
					loopFilteredData,
					worktreePath!,
					pi,
					ctx,
					collector,
				);
				effectiveNextStatus = auditResult.nextStatus;
				// Capture gate failure context for developer feedback loop
				// When a pre-transition hook returns Implementation, the failure note
				// is stored so the next developer iteration receives targeted context.
				applyGateFailureContext(stageState, effectiveNextStatus, auditResult.note, i + 1);

				// Surface gate failure to user so they know developer will re-dispatch
				// with the failure context injected into the next task prompt.
				if (effectiveNextStatus === "Implementation" && auditResult.note) {
					pi.sendMessage({
						customType: "supervisor",
						content: `## 🔴 Pre-Transition Gates Blocked — Returning to Developer\n\n${auditResult.note}\n\nFix issues above and the pipeline will retry automatically.`,
						display: true,
					});
					ctx.ui.notify(
						`Pre-transition gates blocked: ${auditResult.note.slice(0, 120)}… Re-dispatching developer.`,
						"warning",
					);
				}

				// Store dead code result in stage state for auditor context injection
				if (auditResult.deadCodeResult) {
					stageState.deadCodeResult = auditResult.deadCodeResult;
				}
				// Store duplicate code result in stage state for auditor context injection
				if (auditResult.duplicateCodeResult) {
					stageState.duplicateCodeResult = auditResult.duplicateCodeResult;
				}
				// Store vuln scan result in stage state for auditor context injection
				if (auditResult.vulnResult) {
					stageState.vulnResult = auditResult.vulnResult;
				}
				getDebugLogger().info("handler", "Pre-transition hook result", {
					effectiveNextStatus,
					note: auditResult.note,
				});
			} catch (auditErr: unknown) {
				const auditMsg = auditErr instanceof Error ? auditErr.message : String(auditErr);
				ctx.ui.notify(`Pre-audit error: ${auditMsg}`, "warning");
				collector?.push("handler", "warn", `Pre-transition hook error: ${auditMsg}`);
				getDebugLogger().error("handler", "Pre-transition hook error", {
					error: auditMsg,
				});
			}
		}

		// Status transition
		try {
			const prev = loopStatus;
			loopStatus = await applyStatusTransition(
				port,
				loopItem.id,
				projectId,
				fields,
				statusField.id,
				effectiveNextStatus,
			);
			ctx.ui.notify(`Issue #${issueNum} moved: ${prev} → ${loopStatus}`, "info");
			ctx.ui.setStatus("supervisor", `Status: ${loopStatus}`);
			getDebugLogger().info("handler", "Status transition applied", {
				from: prev,
				to: loopStatus,
			});
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			stopReason = `Failed to update status: ${errMsg}`;
			ctx.ui.notify(stopReason, "error");
			collector?.push("handler", "error", `Status transition failed: ${errMsg}`);
			getDebugLogger().error("handler", "Status transition failed", {
				error: errMsg,
			});
			break;
		}
	}

	// Write back loop-scoped state so the post-pipeline phase observes it.
	runCtx.loopStatus = loopStatus;
	runCtx.stopReason = stopReason;
	runCtx.prCreationResult = prCreationResult;
}

/**
 * Pre-Implementation rebase (issue #1473): refresh the worktree onto the
 * latest default branch before a developer dispatch, so same-family PRs
 * landing mid-pipeline don't produce late PR-creation conflicts.
 *
 * Extracted from runAgentLoop (S138 ceiling) — the loop keeps only the
 * guarded call; policy lives here:
 * - Conflict → store files in stageState.rebaseConflictFiles (loop-scoped,
 *   survives Audit→Implementation loop-backs) and return the newline-joined
 *   file list as task context. The aborted rebase discards conflict markers,
 *   so the developer gets explicit merge-reintegration steps in the task.
 * - Success → clear stale conflict context.
 * - Non-conflict failure / exception → fail-open: warn via notify+collector,
 *   clear conflict context, proceed stale (end-rebase + merge handler remain
 *   the correctness backstop; a transient outage must not kill a 20-40min
 *   pipeline).
 *
 * mergeFallback:false — the `git merge --no-edit` fallback's unattributed
 * merge commit would count in hasBranchCommits base..head and pollute the
 * Bug #1343 empty-worktree classifier.
 *
 * @returns conflict context (newline-joined conflicted file paths) or undefined.
 */
async function refreshWorktreeBeforeImplementation(
	runCtx: RunContext,
	worktreePath: string,
): Promise<string | undefined> {
	const { ctx, pi, config, collector, stageState } = runCtx;
	let rebaseConflictContext: string | undefined;
	try {
		const rebaseResult = await tryRebaseOntoBase(
			worktreePath,
			config.defaultBranch!,
			config.remote!,
			pi,
			{ mergeFallback: false },
		);
		if (rebaseResult.success) {
			stageState.rebaseConflictFiles = undefined;
			getDebugLogger().info("handler", "Pre-Implementation rebase OK — no conflicts");
		} else if (rebaseResult.conflictFiles.length > 0) {
			stageState.rebaseConflictFiles = rebaseResult.conflictFiles;
			rebaseConflictContext = rebaseResult.conflictFiles.join("\n");
			ctx.ui.notify(
				`Rebase conflicts with latest ${config.defaultBranch} in ${rebaseResult.conflictFiles.length} file(s) — developer will reintegrate main: ${rebaseResult.conflictFiles.join(", ")}`,
				"warning",
			);
		} else {
			// Non-conflict failure (fetch failed, index.lock, …) — fail-open:
			// proceed stale; end-rebase + merge handler remain the backstop.
			stageState.rebaseConflictFiles = undefined;
			ctx.ui.notify(
				`Cannot rebase onto latest ${config.defaultBranch}: ${rebaseResult.message} — proceeding with current base`,
				"warning",
			);
			collector?.push(
				"handler",
				"warn",
				`Pre-Implementation rebase failed (non-conflict): ${rebaseResult.message}`,
			);
		}
	} catch (rebaseErr: unknown) {
		const rebaseMsg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
		stageState.rebaseConflictFiles = undefined;
		ctx.ui.notify(
			`Pre-Implementation rebase failed: ${rebaseMsg} — proceeding with current base`,
			"warning",
		);
		collector?.push("handler", "warn", `Pre-Implementation rebase failed: ${rebaseMsg}`);
	}
	return rebaseConflictContext;
}
