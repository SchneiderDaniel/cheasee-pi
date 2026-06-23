// ─── Pipeline Handler ────────────────────────────────────────────
// Main /supervisor command handler: status loop, transitions, hook wiring.
// Orchestrates the full pipeline by importing from submodules.
// Stage transition logic is extracted to stages.ts.
// Helpers are in helpers.ts with injected ExecFn/NotifyFn dependencies.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	AgentRunResult,
	SupervisorConfig,
	PipelineAgentResult,
	ParsedAgent,
	DebugLogger,
	PrCreationResult,
	SupervisorMessageDetails,
} from "../config/types.ts";
import { loadConfig, resolveTimeoutMs } from "../config/config.ts";
import { findIssueItem, filterIssueData, postIssueComment } from "../github/index.ts";
import { gh } from "../github/gh-client.ts";
import { buildAgentTask, generateBranchName, summarizeComments } from "../agent/task.ts";

import { runAgentSubprocess } from "../agent/runner.ts";
import { formatTokens, formatDuration } from "../lib/formatting.ts";
import { convertToolResultToAgentRunResult } from "../session/result.ts";
import { renderWidgetFromDetails } from "../session/widget.ts";
import type { SubagentDetails, AgentToolResult } from "../subagent/types.ts";
import {
	WORKFLOW,
	computeAuditScoreFromFindings,
	getActiveAuditDimensions,
	evaluateAuditScoreGate,
} from "../config/workflow.ts";
import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "../agent/output.ts";
import type { AgentOutput } from "../config/types.ts";
import { runTscAndLspAudit } from "../pipeline/audit.ts";
import { buildPipelineSummary, validateAgentResult } from "../pipeline/output.ts";
import { handlePostPipelineMerge } from "../pipeline/merge.ts";
import { createWorktree, installWorktreeDeps, cleanupWorktree } from "./worktree.ts";

import {
	writeCheckpointFile,
	deleteCheckpointFile,
	cleanupStalePipelineState,
} from "./state-checkpoint.ts";
import {
	createCrashCleanup,
	setupCrashCleanup,
	type CrashCleanup,
	type CleanupOnExitDeps,
} from "./crash-cleanup.ts";
import { createPrOnApproval } from "./pr-creation.ts";
import { sendPipelineSummary, sendPipelineError } from "./notifications.ts";
import { ErrorCollector, setErrorCollector, getErrorCollector } from "./error-collector.ts";
import {
	MAX_PIPELINE_LOOPS,
	createStageState,
	handleBacklogTransition,
	isDoneStatus,
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
	buildDuplicateCodeContext,
	applyGateFailureContext,
	type GateRejected,
	buildDeadCodeContext,
} from "./stages.ts";
import {
	fetchIssue,
	readProjectBoard,
	checkDependencies,
	fetchFreshIssueData,
	loadAgentFile as loadAgentFileHelper,
} from "./helpers.ts";
import type { NotifyFn, ExecFn } from "./helpers.ts";
import {
	parseSupervisorArgs,
	enableDebugLogger,
	getDebugLogger,
	setDebugLogger,
	resetDebugLogger,
} from "../lib/debug.ts";

/**
 * Main supervisor handler — processes a GitHub issue through the full Kanban pipeline.
 * Supports --debug flag for structured JSONL logging to /tmp/.
 *
 * Mode adaptation: checks ctx.hasUI before calling dialog methods (confirm/select).
 * Trust gate: checks ctx.isProjectTrusted() before reading config or creating issues.
 * System prompt options: extracts via ctx.getSystemPromptOptions() for agent context.
 * Experimental features: gated behind config.enableExperimentalFeatures.
 */
export async function handleSupervisorCommand(
	args: string | undefined,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	// ── Project Trust Gate ────────────────────────────────────────────
	// Check project trust BEFORE reading config or making any gh calls.
	// Note: only consumption-side check — supervisor cannot register
	// project_trust event handler (it's a project-local extension).
	// #3 (auto-trust via project_trust event) must live in a separate
	// global extension.
	// isProjectTrusted may not be in type definitions for older pi-coding-agent versions
	// but it exists at runtime in v0.79.1+. Use optional chaining via cast.
	const isTrusted = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted?.();
	if (isTrusted === false) {
		const msg = "Project not trusted. Skipping issue operations.";
		if (ctx.hasUI) {
			ctx.ui.notify(msg, "error");
		} else {
			pi.sendMessage({ customType: "supervisor", content: `⚠️ ${msg}`, display: true });
		}
		return;
	}

	// ── System Prompt Options ─────────────────────────────────────────
	// Capture current system prompt options at pipeline start so we can
	// pass relevant context (tools, skills, context files) to sub-agents.
	// This avoids token waste from redundant context loading.
	let systemPromptOptions:
		| {
				selectedTools?: string[];
				contextFiles?: string[];
				skills?: string[];
		  }
		| undefined;
	// getSystemPromptOptions may not be in type definitions for older pi-coding-agent versions
	// but it exists at runtime in v0.78.1+. Use optional chaining via cast.
	const ctxWithOpts = ctx as {
		getSystemPromptOptions?: () =>
			| {
					selectedTools?: string[];
					contextFiles?: string[];
					skills?: string[];
			  }
			| undefined;
	};
	if (typeof ctxWithOpts.getSystemPromptOptions === "function") {
		try {
			const opts = ctxWithOpts.getSystemPromptOptions();
			if (opts) {
				systemPromptOptions = {
					selectedTools: opts.selectedTools as string[] | undefined,
					contextFiles: opts.contextFiles as string[] | undefined,
					skills: opts.skills as string[] | undefined,
				};
			}
		} catch {
			// Non-critical — proceed without prompt options
		}
	}

	// Parse args using parseSupervisorArgs (parseArgs-compatible wrapper)
	const parsed = parseSupervisorArgs(args);
	const issueNum = parsed.issueNum;
	const isDebug = parsed.isDebug;

	// Setup debug logger if --debug flag present
	if (isDebug) {
		const logger = enableDebugLogger(ctx.cwd || process.cwd());
		logger.info("handler", "Supervisor pipeline started with --debug", {
			args,
			parsedIssueNum: issueNum,
			cwd: ctx.cwd,
		});
		if (ctx.hasUI) {
			ctx.ui.notify(`Debug logging enabled → ${logger.getLogPath()}`, "info");
		}
	}

	if (!issueNum || issueNum < 1) {
		const usageMsg = "Usage: /supervisor [--debug] <issue-number>";
		if (ctx.hasUI) {
			ctx.ui.notify(usageMsg, "error");
		} else {
			pi.sendMessage({ customType: "supervisor", content: `⚠️ ${usageMsg}`, display: true });
		}
		if (isDebug) {
			getDebugLogger().error("handler", "Invalid issue number", { args, parsed });
		}
		resetDebugLogger();
		return;
	}

	// Clear any stale supervisor status from previous pipeline runs
	ctx.ui.setStatus("supervisor", undefined);

	const agentResults: PipelineAgentResult[] = [];
	let stopReason: string | undefined;
	let config!: SupervisorConfig;
	let issueTitle = "";
	let worktreePath: string | undefined;
	let worktreeBranch: string | undefined;
	let prCreationResult: PrCreationResult | undefined;
	let collector: ErrorCollector;
	let crashCleanup: CrashCleanup | undefined;

	// Build ExecFn and NotifyFn from pi/ctx for helpers
	// Mode adaptation: ctx.ui.notify is fire-and-forget (safe in all modes,
	// silently drops in print/json mode). Dialog methods (confirm/select)
	// need ctx.hasUI check before calling.
	const exec: ExecFn = pi.exec.bind(pi);
	const notify: NotifyFn = {
		info: (msg) => {
			if (ctx.hasUI) {
				ctx.ui.notify(msg, "info");
			}
		},
		error: (msg) => {
			if (ctx.hasUI) {
				ctx.ui.notify(msg, "error");
			}
		},
	};

	// Create ErrorCollector for this pipeline run
	collector = new ErrorCollector();
	setErrorCollector(collector);

	try {
		config = loadConfig();
		getDebugLogger().info("handler", "Config loaded", {
			repo: config.repo,
			projectNumber: config.projectNumber,
			submodules: config.submodules?.length,
		});

		// Experimental features gate
		// When enableExperimentalFeatures is false/undefined, advanced
		// pipeline features (auto-forking, advanced parallelism) are skipped.
		// Currently no experimental stages exist in the WORKFLOW — this flag
		// is forward-looking for future stages that can opt in.
		const experimentalEnabled = config.enableExperimentalFeatures === true;
		if (!experimentalEnabled) {
			getDebugLogger().info("handler", "Experimental features disabled — running core stages only");
		} else {
			getDebugLogger().info("handler", "Experimental features enabled");
		}

		// Fetch issue
		if (ctx.hasUI) {
			ctx.ui.notify(`Fetching issue #${issueNum}...`, "info");
		}
		const issueData = await fetchIssue(exec, notify, config, issueNum, collector);
		if (!issueData) return;
		issueTitle = (issueData?.title as string) || `Issue #${issueNum}`;

		// Push issue data to footer (context-info extension)
		// Uses shared pi.events bus instead of dynamic import. Dynamic import
		// creates a separate module instance (jiti vs native ESM), so the
		// module-level stateRef in setSupervisorIssueData was never set there.
		// Events on pi.events are safe because all extensions share the same
		// event bus instance, and context-info's listener is registered on it.
		pi.events.emit("supervisor:issue-data", {
			issueNumber: issueNum,
			issueRepo: config.repo,
			issueTitle,
		});

		pi.sendMessage({
			customType: "supervisor",
			content: `## GitHub Issue: [#${issueNum}] ${issueTitle}\n\n**Repository:** \`${config.repo}\``,
			display: true,
		});

		getDebugLogger().info("handler", "Issue fetched", {
			issueNum,
			title: issueTitle,
			repo: config.repo,
		});

		const filteredData = filterIssueData(issueData, config.codeowners);

		// Read project board
		ctx.ui.setStatus("supervisor", "Reading project board...");
		const { fields, items, projectId, statusField } = await readProjectBoard(
			exec,
			notify,
			config,
			issueNum,
			collector,
		);
		if (!fields || !statusField) {
			getDebugLogger().error("handler", "Project board read failed", {
				hasFields: !!fields,
				hasStatusField: !!statusField,
			});
			return;
		}
		const loopItem = findIssueItem(items, issueNum);
		if (!loopItem) {
			ctx.ui.notify(`Issue #${issueNum} not on project board #${config.projectNumber}.`, "error");
			getDebugLogger().error("handler", "Issue not on project board", {
				issueNum,
				projectNumber: config.projectNumber,
			});
			ctx.ui.setStatus("supervisor", undefined);
			return;
		}

		getDebugLogger().info("handler", "Project board read OK", {
			itemId: loopItem.id,
			status: loopItem.status || "Unknown",
		});

		// Dependency gate
		ctx.ui.setStatus("supervisor", "Checking dependencies...");
		if (!(await checkDependencies(exec, notify, config, issueNum, collector))) {
			getDebugLogger().warn("handler", "Dependency check blocked", { issueNum });
			return;
		}

		// Pipeline main loop
		ctx.ui.setStatus("supervisor", "Setting up pipeline...");
		const stageState = createStageState(loopItem.status || "Unknown");
		let { loopStatus } = stageState;

		// Create worktree before loop — available for ALL agents (researcher, architect, developer, auditor).
		// This ensures temp files (researcher JSON findings) go to worktree, not main repo,
		// and worktree-sandbox extension activates for all agents.
		worktreeBranch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

		// ── Stale State Cleanup ──────────────────────────────────────────
		// Before creating a new worktree, clean up any stale checkpoints from
		// crashed pipeline runs. Non-blocking — if cleanup fails, log warning
		// and continue (startup should not fail because of stale cleanup).
		{
			const staleCleanupResult = await cleanupStalePipelineState(pi, ctx.cwd, config, notify);
			if (!staleCleanupResult.ok) {
				ctx.ui.notify(
					`Warning: Stale worktree cleanup had errors: ${staleCleanupResult.error}`,
					"warning",
				);
				getDebugLogger().warn("handler", "Stale worktree cleanup had errors", {
					error: staleCleanupResult.error,
				});
			}
		}

		ctx.ui.setStatus("supervisor", "Creating worktree...");
		getDebugLogger().info("handler", "Creating worktree", {
			branch: worktreeBranch,
			base: config.worktreeBase,
		});
		const createResult = await createWorktree(
			pi,
			ctx.cwd,
			config.worktreeBase!,
			worktreeBranch,
			config.defaultBranch!,
			notify,
		);
		if (!createResult.ok) {
			ctx.ui.notify(`Failed to create worktree: ${createResult.error}`, "error");
			getDebugLogger().error("handler", "Worktree creation failed", {
				error: createResult.error,
			});
			collector?.push("worktree", "error", `Failed to create worktree: ${createResult.error}`);
			worktreePath = undefined;
			// Don't continue without a worktree — send error and stop
			sendPipelineError(
				pi,
				ctx,
				agentResults,
				issueNum,
				issueTitle,
				config,
				createResult.error,
				stageState.gateFailureHistory,
			);
			return;
		}
		worktreePath = createResult.value;

		ctx.ui.setStatus("supervisor", "Installing worktree dependencies...");
		const depsResult = await installWorktreeDeps(pi, worktreePath, notify);
		if (!depsResult.ok) {
			collector?.push("worktree", "warn", `npm ci failed: ${depsResult.error}`);
		}
		getDebugLogger().info("handler", "Worktree ready", { worktreePath });

		// ── Signal Handlers for Crash Cleanup ──────────────────────────
		// Register before pipeline loop so accidental process termination
		// (SIGTERM from orchestrator, SIGINT from Ctrl+C) still cleans up
		// the worktree. Unregister in finally block below.
		{
			const cleanupDeps: CleanupOnExitDeps = {
				worktreePath,
				worktreeBranch,
				pi,
				cwd: ctx.cwd,
				notify,
				debugLogger: getDebugLogger(),
			};
			crashCleanup = setupCrashCleanup(cleanupDeps);
			getDebugLogger().info("handler", "Crash cleanup handlers registered (SIGTERM/SIGINT)");
		}

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
					pi,
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

			// Fetch fresh issue data for this iteration
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
						pi,
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
			const task = buildAgentTask(
				agentName,
				issueNum,
				config.repo,
				issueTitle,
				loopFilteredData,
				config.submodules || [],
				config.defaultBranch!,
				config.remote!,
				config.worktreeBase!,
				config.branchPrefix!,
				worktreePath,
				worktreeBranch,
				summarizeComments(loopFilteredData.comments),
				dupContext,
				researchFindings,
				auditFeedback,
				deadContext,
				stageState.gateFailureContext,
				systemPromptOptions,
			);

			getDebugLogger().info("handler", `Dispatching agent ${agentName}`, {
				model: agent.config.model,
				timeoutMs,
				taskLen: task.length,
				cwdOverride: worktreePath,
			});

			// Execute agent
			const { result, usedRetry } = await executeAgent(
				agent,
				task,
				ctx,
				pi,
				timeoutMs,
				worktreePath,
				config.maxToolCalls,
				config.agentTokenBudget,
				issueTitle,
			);

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
			const auditInfo = trackAuditScore(result.textOnly, stageState);
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
				const parseResult = parseAgentOutput(result.textOutput);
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
			);

			getDebugLogger().info("handler", "Next status determined", {
				nextStatus,
				stopReason: nsStop,
			});

			// Bug #643: Pre-condition check before auditor — if developer produced
			// no commits (branch is empty ahead of base), skip auditor and stop pipeline.
			// This prevents the auditor from wasting tokens on an empty worktree.
			if (agentName === "developer" && nextStatus === "Audit" && worktreePath && result.success) {
				const hasCommits = await hasBranchCommits(
					(cmd: string, args: string[], opts?: Record<string, unknown>) => pi.exec(cmd, args, opts),
					worktreePath,
					worktreeBranch || config.branchPrefix! + issueNum,
					config.defaultBranch || "main",
				);
				if (!hasCommits) {
					stopReason = "Developer produced no commits — skipping auditor";
					ctx.ui.notify("Developer produced no changes. Pipeline stopping.", "warning");
					getDebugLogger().warn("handler", "No commits from developer", {
						worktreeBranch,
						config: config.defaultBranch,
					});
					// Close issue on GitHub: no changes needed (already resolved)
					try {
						await postIssueComment(
							exec,
							issueNum,
							config.repo,
							"## Issue Already Resolved\n\nDeveloper produced no changes — the codebase already reflects the required state. Closing.",
						);
						await gh(exec, ["issue", "close", String(issueNum), "--repo", config.repo]);
						ctx.ui.notify(`Issue #${issueNum} closed — already resolved`, "info");
					} catch (closeErr: unknown) {
						const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
						ctx.ui.notify(`Failed to close issue: ${closeMsg}`, "warning");
						collector?.push("handler", "warn", `Failed to close issue #${issueNum}: ${closeMsg}`);
					}
					break;
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
				);
				if (prCreationResult && !prCreationResult.success) {
					getDebugLogger().warn("handler", "PR creation failed", {
						error: prCreationResult.error,
					});
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
							await postIssueComment(exec, issueNum, config.repo, budgetExceededMsg);
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
							pi,
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
					// Store dead code result in stage state for auditor context injection
					if (auditResult.deadCodeResult) {
						stageState.deadCodeResult = auditResult.deadCodeResult;
					}
					// Store duplicate code result in stage state for auditor context injection
					if (auditResult.duplicateCodeResult) {
						stageState.duplicateCodeResult = auditResult.duplicateCodeResult;
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
					pi,
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

		// Post-pipeline operations with correct ordering:
		// 1. Merge resolution (needs worktree to exist)
		// 2. Worktree cleanup (after merge is complete)
		await handlePostPipeline(
			issueNum,
			issueTitle,
			loopStatus,
			agentResults,
			config,
			pi,
			ctx,
			worktreePath,
			worktreeBranch,
			prCreationResult,
			isDebug,
			collector,
			notify,
		);

		// Completion notification
		if (agentResults.length > 0 || stopReason !== undefined) {
			// Compute overall status considering PR creation result
			// If loop reached Done but PR creation failed, still report as "success"
			// with a PR-creation-failure note (Bug 4 fix)
			const overallStatus: "success" | "failed" | "stopped" = isDoneStatus(loopStatus)
				? "success"
				: agentResults.some((a) => a.status === "FAILED")
					? "failed"
					: "stopped";
			sendPipelineSummary(
				pi,
				ctx,
				agentResults,
				overallStatus,
				issueNum,
				issueTitle,
				config,
				stopReason,
				prCreationResult,
				collector,
				stageState.gateFailureHistory,
			);
			getDebugLogger().info("handler", "Pipeline finished", {
				overallStatus,
				agentCount: agentResults.length,
				stopReason,
				totalDurationMs: agentResults.reduce((s, a) => s + a.durationMs, 0),
			});
		} else {
			ctx.ui.setStatus("supervisor", undefined);
		}
	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		getDebugLogger().error("handler", "Pipeline threw unhandled error", { error: errMsg });
		collector?.push("handler", "error", `Pipeline threw unhandled error: ${errMsg}`);
		// Also cleanup on error
		if (worktreePath && worktreeBranch) {
			const cleanResult = await cleanupWorktree(pi, ctx.cwd, worktreePath, worktreeBranch, notify);
			if (!cleanResult.ok) {
				getDebugLogger().warn("handler", `Worktree cleanup on error failed: ${cleanResult.error}`);
			}
		}
		// Delete checkpoint file on error (idempotent)
		{
			const delResult = deleteCheckpointFile(ctx.cwd);
			if (!delResult.ok) {
				getDebugLogger().warn(
					"handler",
					`Failed to delete checkpoint on error: ${delResult.error}`,
				);
			}
		}
		sendPipelineError(pi, ctx, agentResults, issueNum, issueTitle, config, errMsg);
	} finally {
		// Clear supervisor issue data from footer (any outcome)
		// Uses shared pi.events bus instead of dynamic import.
		pi.events.emit("supervisor:issue-data", null);

		// Teardown signal handlers so they don't leak beyond pipeline
		if (crashCleanup) {
			crashCleanup.teardown();
			getDebugLogger().info("handler", "Crash cleanup handlers removed");
		}
		if (isDebug) {
			const logPath = getDebugLogger().getLogPath();
			ctx.ui.notify(`Debug log: ${logPath}`, "info");
			resetDebugLogger();
		}
	}
}

// ─── Post-Pipeline Operations ──────────────────────────────────────
// Extracted for testability — runs merge before cleanup.
// Order: merge (needs worktree) → cleanup (deletes worktree).
// In try/finally so cleanup always runs even if merge throws.
// When debug is active and PR creation failed, worktree is preserved
// for post-hoc inspection (Bug 7 fix).

export async function handlePostPipeline(
	issueNum: number,
	issueTitle: string,
	loopStatus: string,
	agentResults: PipelineAgentResult[],
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
	prCreationResult?: PrCreationResult,
	isDebug?: boolean,
	collector?: ErrorCollector,
	notify?: NotifyFn,
): Promise<void> {
	try {
		// Step 1: Post-pipeline merge resolution — needs worktree to exist
		if (isDoneStatus(loopStatus) && agentResults.length > 0) {
			await handlePostPipelineMerge(
				issueNum,
				issueTitle,
				loopStatus,
				config,
				pi,
				ctx,
				worktreePath,
				collector,
			);
		}
	} finally {
		// Step 2: Worktree cleanup — always runs, even if merge throws
		// Exception: preserve worktree on PR failure when debug is active
		// (Bug 7 fix — keeps evidence for post-hoc debugging)
		if (worktreePath && worktreeBranch) {
			const prFailed = prCreationResult && !prCreationResult.success;
			if (isDebug && prFailed) {
				const log = getDebugLogger();
				log.info("handler", "PR creation failed in debug mode — preserving worktree", {
					worktreePath,
					branch: worktreeBranch,
				});
				ctx.ui.notify(
					`PR creation failed. Worktree preserved at ${worktreePath} for inspection.`,
					"warning",
				);
			} else {
				const cleanResult = await cleanupWorktree(
					pi,
					ctx.cwd,
					worktreePath,
					worktreeBranch,
					notify ||
						({
							info: () => {},
							error: () => {},
						} as NotifyFn),
				);
				if (!cleanResult.ok) {
					getDebugLogger().warn("handler", `Worktree cleanup failed: ${cleanResult.error}`);
				}
			}
		}
		// Delete checkpoint file on pipeline completion (idempotent)
		const delResult = deleteCheckpointFile(ctx.cwd);
		if (!delResult.ok) {
			getDebugLogger().warn("handler", `Failed to delete checkpoint: ${delResult.error}`);
		}
	}
}

// ─── Execute Agent (hybrid: subagent tool with subprocess fallback) ──
// Primary path: pi.executeTool() dispatches through registered tool for native TUI rendering.
// Fallback: runAgentSubprocess() when subagent fails (widget-based, no inline streaming).

export async function executeAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	_timeoutMs: number,
	agentCwd: string | undefined,
	maxToolCalls?: number,
	agentTokenBudget?: number,
	issueTitle?: string,
): Promise<{ result: AgentRunResult; usedRetry: boolean }> {
	// Send start message (1 message to session, no streaming updates)
	const shortModel = agent.config.model
		? agent.config.model.split("/").pop() || agent.config.model
		: "";
	const taskPreview = issueTitle || task.split("\n")[0]?.slice(0, 120) || "";
	pi.sendMessage({
		customType: "supervisor",
		content: `**⚙ ${agent.config.name}** — Starting\n\nModel: \`${shortModel}\`\nTask: ${taskPreview}`,
		display: true,
		details: { eventType: "phase-change", agentName: agent.config.name, phase: "starting" },
	});

	// Widget for progress display (above editor, zero session cost)
	let clearWidget: (() => void) | undefined;
	let widgetId: string | undefined;
	if (ctx.hasUI) {
		widgetId = `agent-${agent.config.name}`;
		clearWidget = () => ctx.ui.setWidget(widgetId!, undefined);
	} else {
		clearWidget = () => {};
	}

	// Track state for delta event dispatch
	let lastPhase: string | undefined;
	let lastCurrentTool: string | undefined;
	let lastResultCount = 0;
	let lastCompacted = false;
	let lastStatusLabel: string | undefined;
	let lastSentThinking = "";

	// Primary: pi.executeTool dispatches through registered tool with expanded onUpdate.
	// onUpdate sends per-event messages for ALL lifecycle events via eventType discriminator.
	const toolResult = await pi.executeTool(
		"subagent",
		{
			agent: agent.config.name,
			task,
			cwd: agentCwd,
			maxToolCalls,
			agentTokenBudget,
		},
		{
			signal: ctx.signal,
			onUpdate: (partial: AgentToolResult<Partial<SubagentDetails>>) => {
				const d = partial.details;
				if (!d) return;

				// Widget (above editor, zero session cost)
				if (ctx.hasUI && widgetId) {
					renderWidgetFromDetails(d, agent.config.name, shortModel, ctx, widgetId);
				}

				// ── Per-event lifecycle messages via eventType discriminator ──
				const agentName = agent.config.name;

				// 1. Phase change
				if (d.phase && d.phase !== lastPhase) {
					lastPhase = d.phase;
					pi.sendMessage({
						customType: "supervisor",
						content: `⏳ ${agentName} — ${d.phase} phase`,
						display: true,
						details: { eventType: "phase-change", agentName, phase: d.phase },
					});
				}

				// 2. Tool start
				if (d.currentTool && d.currentTool !== lastCurrentTool) {
					lastCurrentTool = d.currentTool;
					let argsStr = "";
					if (d.currentToolArgs) {
						try {
							const parsed = JSON.parse(d.currentToolArgs);
							argsStr = JSON.stringify(parsed).slice(0, 120);
						} catch {
							argsStr = d.currentToolArgs.slice(0, 120);
						}
					}
					pi.sendMessage({
						customType: "supervisor",
						content: `⏳ ${agentName} — ${d.currentTool} ${argsStr}`,
						display: true,
						details: { eventType: "tool-start", agentName, toolName: d.currentTool, args: argsStr },
					});
				}

				// 3. Tool completed (delta-based on toolResults length)
				const tr = d.toolResults;
				const trCount = tr?.length || 0;
				if (trCount > lastResultCount && tr) {
					const tc = d.toolCalls || [];
					const content0 = partial.content?.[0];
					const fullText = content0 && content0.type === "text" ? content0.text : "";
					const thinking = fullText.slice(0, 4000);
					for (let i = lastResultCount; i < trCount; i++) {
						const r = tr[i];
						if (!r) continue;
						const call = tc[i];
						let argsStr = "";
						let paramsStr = "";
						if (call?.args) {
							const a = call.args;
							if (typeof a.path === "string") {
								argsStr = a.path;
								const parts = [];
								if (a.offset !== undefined) parts.push(`offset=${a.offset}`);
								if (a.limit !== undefined) parts.push(`limit=${a.limit}`);
								if (parts.length) paramsStr = parts.join(" ");
							} else if (typeof a.url === "string") {
								argsStr = a.url;
								const parts = [];
								if (a.maxPages !== undefined) parts.push(`maxPages=${a.maxPages}`);
								if (a.maxTokens !== undefined) parts.push(`maxTokens=${a.maxTokens}`);
								if (parts.length) paramsStr = parts.join(" ");
							} else if (typeof a.command === "string") {
								argsStr = a.command.slice(0, 100);
								if (a.timeout !== undefined) paramsStr = `timeout=${a.timeout}s`;
							} else if (typeof a.query === "string") {
								argsStr = a.query.slice(0, 100);
								const parts = [];
								if (a.directory) parts.push(`dir:${a.directory}`);
								if (a.max_count !== undefined) parts.push(`max=${a.max_count}`);
								if (a.maxResults) parts.push(`maxResults=${a.maxResults}`);
								if (parts.length) paramsStr = parts.join(" ");
							} else if (typeof a.agent === "string") {
								argsStr = a.agent;
								const parts = [];
								if (a.maxToolCalls !== undefined) parts.push(`maxTools=${a.maxToolCalls}`);
								if (a.agentTokenBudget !== undefined) parts.push(`budget=${a.agentTokenBudget}`);
								if (parts.length) paramsStr = parts.join(" ");
							} else if (Array.isArray(a.edits)) {
								argsStr = (a.path as string) || "";
								paramsStr = `[${a.edits.length} edits]`;
							} else if (typeof a.content === "string") {
								argsStr = (a.path as string) || "";
								const preview = a.content.length > 60 ? a.content.slice(0, 60) + "..." : a.content;
								paramsStr = `content:\`${preview}\``;
							} else if (typeof a.limit === "number") {
								argsStr = (a.path as string) || "";
								paramsStr = `limit=${a.limit}`;
							} else {
								argsStr = JSON.stringify(a).slice(0, 120);
							}
						}
						const rWithResult = r as any;
						let errorReason = "";
						if (r.isError) {
							if (typeof rWithResult.result === "string" && rWithResult.result) {
								errorReason = rWithResult.result.slice(0, 300);
							} else {
								const errLine = thinking
									.split("\n")
									.filter((l) => /error|fail|denied|ENOENT|not found|blocked/i.test(l))
									.pop();
								errorReason = errLine ? errLine.slice(0, 200) : "Tool failed";
							}
						}
						const thinkMatch = fullText.match(/(?:^|\n)💭\n([\s\S]*?)(?:\n\n|$)/);
						const currentThinking = thinkMatch ? thinkMatch[1] : "";
						const incremental = currentThinking.startsWith(lastSentThinking)
							? currentThinking.slice(lastSentThinking.length).trimStart()
							: currentThinking;
						lastSentThinking = currentThinking;
						pi.sendMessage({
							customType: "supervisor",
							content: `${r.name} \`${argsStr}\``,
							display: true,
							details: {
								eventType: "tool-complete",
								agentName,
								toolName: r.name,
								args: argsStr,
								params: paramsStr || undefined,
								isError: !!r.isError,
								errorReason,
								thinking: incremental,
								resultText: rWithResult.result ? rWithResult.result.slice(0, 2000) : undefined,
								toolIndex: `#${i + 1}`,
								runningTokenCount: d.runningTokenCount,
								runningToolCount: d.runningToolCount,
								toolDurationMs: (r as any).durationMs,
								errorCount: d.errorCount,
								maxToolCalls: d.maxToolCalls,
								agentTokenBudget: d.agentTokenBudget,
								compacted: d.compacted,
							},
						});
					}
					lastResultCount = trCount;
				}

				// 4. Compaction detection
				if (d.compacted && !lastCompacted) {
					lastCompacted = true;
					pi.sendMessage({
						customType: "supervisor",
						content: "⚠ compacted",
						display: true,
						details: { eventType: "compaction", agentName },
					});
				}

				// 5. Budget exceeded detection
				if (d.statusLabel === "BUDGET_EXCEEDED" && lastStatusLabel !== "BUDGET_EXCEEDED") {
					lastStatusLabel = d.statusLabel;
					pi.sendMessage({
						customType: "supervisor",
						content: `⚠ ${agentName} — budget exceeded (${d.runningToolCount ?? "?"} tools, ${d.runningTokenCount ?? "?"} tokens)`,
						display: true,
						details: {
							eventType: "budget-exceeded",
							agentName,
							toolCount: d.runningToolCount ?? 0,
							tokenCount: d.runningTokenCount ?? 0,
						},
					});
				} else if (d.statusLabel && d.statusLabel !== lastStatusLabel) {
					lastStatusLabel = d.statusLabel;
				}
			},
		},
	);

	if (clearWidget) clearWidget();

	// Send final result — single message with eventType: "subagent-result" for rich expandable view
	const partial = toolResult as any;
	const d = partial.details || partial;
	if (d && d.agentName) {
		const finalStatus = d.success ? "✅" : "❌";
		pi.sendMessage({
			customType: "supervisor",
			content: `${finalStatus} ${agent.config.name} — ${d.statusLabel || "Done"}\n\n${d.summaryLine || ""}`,
			display: true,
			details: {
				eventType: "subagent-result",
				agentName: agent.config.name,
				content: partial.content,
				details: partial.details,
			},
		});
	}

	let result = convertToolResultToAgentRunResult(toolResult);
	validateAgentResult(result);
	let usedRetry = false;

	if (result.budgetExceeded) {
		ctx.ui.notify(`Agent ${agent.config.name} exceeded budget — not retrying`, "warning");
	} else if (!result.success) {
		ctx.ui.notify(`Agent ${agent.config.name} failed. Retrying once via subprocess...`, "warning");
		// Fallback: subprocess (no live chat messages)
		ctx.ui.notify(
			"Chat progress streaming unavailable in subprocess mode — only final result will appear in chat",
			"warning",
		);
		result = await runAgentSubprocess(
			agent,
			task,
			ctx,
			_timeoutMs,
			agentCwd,
			maxToolCalls,
			agentTokenBudget,
		);
		usedRetry = true;
		validateAgentResult(result);
	}

	return { result, usedRetry };
}
