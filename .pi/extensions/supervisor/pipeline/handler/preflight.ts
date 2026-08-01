// ─── Pipeline Handler Package: Preflight ─────────────────────────
// Entry gates + pre-loop setup (issue #1395 split of handler.ts).
// Owns: trust gate, system-prompt capture, arg parsing, debug logger,
// ErrorCollector init, exec/notify build, config/port, issue + board
// fetch, dependency gate, stale-state cleanup, worktree creation,
// crash-cleanup registration. Populates RunContext and reports whether
// the pipeline should continue to the agent loop.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	FilteredIssueData,
	ProjectField,
	ProjectItem,
} from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { loadConfig } from "../../config/config.ts";
import { findIssueItem, filterIssueData } from "../../lib/issue-filter.ts";
import { createGitHubPort } from "../../github/ports.ts";
import { generateBranchName } from "../../agent/task.ts";
import { createWorktree, installWorktreeDeps } from "../worktree.ts";
import { cleanupStalePipelineState } from "../state-checkpoint.ts";
import { setupCrashCleanup, type CleanupOnExitDeps } from "../crash-cleanup.ts";
import { ErrorCollector, setErrorCollector } from "../error-collector.ts";
import { fetchIssue, readProjectBoard, checkDependencies } from "../helpers.ts";
import type { NotifyFn, ExecFn } from "../helpers.ts";
import { createStageState } from "../stages/index.ts";
import type { StageState } from "../stages/index.ts";
import { sendPipelineError } from "../notifications.ts";
import {
	parseSupervisorArgs,
	enableDebugLogger,
	getDebugLogger,
	resetDebugLogger,
} from "../../lib/debug.ts";
import type { RunContext } from "./shared.ts";

// ─── Entry gates ─────────────────────────────────────────────────
// Runs BEFORE the main try/catch/finally in index.ts — matches the
// pre-refactor control flow (trust gate / bad-args return without
// hitting the finally block).

export function preparePipelineContext(
	args: string | undefined,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): RunContext | null {
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
		return null;
	}

	// ── System Prompt Options ─────────────────────────────────────────
	const systemPromptOptions = captureSystemPromptOptions(ctx);

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
		return null;
	}

	// Clear any stale supervisor status from previous pipeline runs
	ctx.ui.setStatus("supervisor", undefined);

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
	const collector = new ErrorCollector();
	setErrorCollector(collector);

	return buildRunContextSkeleton({
		args,
		ctx,
		pi,
		issueNum,
		isDebug,
		systemPromptOptions,
		exec,
		notify,
		collector,
	});
}

// ─── RunContext skeleton ─────────────────────────────────────────
// Preflight-populated fields are assigned by runPreflight before
// runAgentLoop runs (see RunContext doc in shared.ts). The undefined
// casts mirror the pre-refactor `let config!: SupervisorConfig`
// definite-assignment idiom.
function buildRunContextSkeleton(params: {
	args: string | undefined;
	ctx: ExtensionCommandContext;
	pi: ExtensionAPI;
	issueNum: number;
	isDebug: boolean;
	systemPromptOptions: RunContext["systemPromptOptions"];
	exec: ExecFn;
	notify: NotifyFn;
	collector: ErrorCollector;
}): RunContext {
	return {
		args: params.args,
		ctx: params.ctx,
		pi: params.pi,
		issueNum: params.issueNum,
		isDebug: params.isDebug,
		systemPromptOptions: params.systemPromptOptions,
		exec: params.exec,
		notify: params.notify,
		collector: params.collector,
		config: undefined as unknown as SupervisorConfig,
		port: undefined as unknown as GitHubPort,
		issueTitle: "",
		filteredData: undefined as unknown as FilteredIssueData,
		issueData: undefined as unknown as Record<string, unknown>,
		stageState: undefined as unknown as StageState,
		loopStatus: "",
		loopItem: undefined as unknown as ProjectItem,
		fields: undefined as unknown as ProjectField[],
		statusField: undefined as unknown as ProjectField,
		projectId: "",
		worktreePath: undefined,
		worktreeBranch: undefined,
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
	};
}

// ─── System Prompt Options capture ───────────────────────────────
// Capture current system prompt options at pipeline start so we can
// pass relevant context (tools, skills, context files) to sub-agents.
// This avoids token waste from redundant context loading.
// getSystemPromptOptions may not be in type definitions for older pi-coding-agent versions
// but it exists at runtime in v0.78.1+. Use optional chaining via cast.
function captureSystemPromptOptions(ctx: ExtensionCommandContext):
	| {
			selectedTools?: string[];
			contextFiles?: string[];
			skills?: string[];
	  }
	| undefined {
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
				return {
					selectedTools: opts.selectedTools as string[] | undefined,
					contextFiles: opts.contextFiles as string[] | undefined,
					skills: opts.skills as string[] | undefined,
				};
			}
		} catch {
			// Non-critical — proceed without prompt options
		}
	}
	return undefined;
}

// ─── Preflight phases ────────────────────────────────────────────
// Each phase is a small function (<100 lines) so the S138 ceiling is
// not re-tripped by this package.

export async function runPreflight(runCtx: RunContext): Promise<boolean> {
	loadPipelineBasics(runCtx);
	if (!(await fetchIssueAndEmit(runCtx))) return false;
	if (!(await readBoardAndGates(runCtx))) return false;
	if (!(await setupPipelineState(runCtx))) return false;
	if (!(await createPipelineWorktree(runCtx))) return false;
	return true;
}

// Config load + GitHub port + experimental gate. Throws propagate to
// the top-level catch in index.ts (sendPipelineError, no worktree).
function loadPipelineBasics(runCtx: RunContext): void {
	runCtx.config = loadConfig();
	getDebugLogger().info("handler", "Config loaded", {
		repo: runCtx.config.repo,
		projectNumber: runCtx.config.projectNumber,
		submodules: runCtx.config.submodules?.length,
	});

	// Create GitHubPort — throws if no token found
	runCtx.port = createGitHubPort();

	// Experimental features gate
	// When enableExperimentalFeatures is false/undefined, advanced
	// pipeline features (auto-forking, advanced parallelism) are skipped.
	// Currently no experimental stages exist in the WORKFLOW — this flag
	// is forward-looking for future stages that can opt in.
	const experimentalEnabled = runCtx.config.enableExperimentalFeatures === true;
	if (!experimentalEnabled) {
		getDebugLogger().info("handler", "Experimental features disabled — running core stages only");
	} else {
		getDebugLogger().info("handler", "Experimental features enabled");
	}
}

// Fetch issue → push footer data → notify + filter. Returns false when
// the issue is not found (early return, footer-integration semantics).
async function fetchIssueAndEmit(runCtx: RunContext): Promise<boolean> {
	const { ctx, pi, exec, notify, collector, config, issueNum } = runCtx;

	if (ctx.hasUI) {
		ctx.ui.notify(`Fetching issue #${issueNum}...`, "info");
	}
	const issueData = await fetchIssue(exec, notify, config, issueNum, collector);
	if (!issueData) return false;
	runCtx.issueData = issueData;
	runCtx.issueTitle = (issueData?.title as string) || `Issue #${issueNum}`;

	// Push issue data to footer (context-info extension)
	// Uses shared pi.events bus instead of dynamic import. Dynamic import
	// creates a separate module instance (jiti vs native ESM), so the
	// module-level stateRef in setSupervisorIssueData was never set there.
	// Events on pi.events are safe because all extensions share the same
	// event bus instance, and context-info's listener is registered on it.
	pi.events.emit("supervisor:issue-data", {
		issueNumber: issueNum,
		issueRepo: config.repo,
		issueTitle: runCtx.issueTitle,
	});

	pi.sendMessage({
		customType: "supervisor",
		content: `## GitHub Issue: [#${issueNum}] ${runCtx.issueTitle}\n\n**Repository:** \`${config.repo}\``,
		display: true,
	});

	getDebugLogger().info("handler", "Issue fetched", {
		issueNum,
		title: runCtx.issueTitle,
		repo: config.repo,
	});

	runCtx.filteredData = filterIssueData(issueData, config.codeowners);
	return true;
}

// Project board read + issue lookup + dependency gate.
async function readBoardAndGates(runCtx: RunContext): Promise<boolean> {
	const { ctx, exec, notify, collector, config, issueNum, port } = runCtx;

	// Read project board
	ctx.ui.setStatus("supervisor", "Reading project board...");
	const { fields, items, projectId, statusField } = await readProjectBoard(
		exec,
		notify,
		config,
		issueNum,
		collector,
		port,
	);
	if (!fields || !statusField) {
		getDebugLogger().error("handler", "Project board read failed", {
			hasFields: !!fields,
			hasStatusField: !!statusField,
		});
		return false;
	}
	const loopItem = findIssueItem(items, issueNum);
	if (!loopItem) {
		ctx.ui.notify(`Issue #${issueNum} not on project board #${config.projectNumber}.`, "error");
		getDebugLogger().error("handler", "Issue not on project board", {
			issueNum,
			projectNumber: config.projectNumber,
		});
		ctx.ui.setStatus("supervisor", undefined);
		return false;
	}
	runCtx.loopItem = loopItem;
	runCtx.fields = fields;
	runCtx.statusField = statusField;
	runCtx.projectId = projectId;

	getDebugLogger().info("handler", "Project board read OK", {
		itemId: loopItem.id,
		status: loopItem.status || "Unknown",
	});

	// Dependency gate
	ctx.ui.setStatus("supervisor", "Checking dependencies...");
	if (!(await checkDependencies(exec, notify, config, issueNum, collector, port))) {
		getDebugLogger().warn("handler", "Dependency check blocked", { issueNum });
		return false;
	}
	return true;
}

// Stage state init, branch naming, stale-state cleanup.
async function setupPipelineState(runCtx: RunContext): Promise<boolean> {
	const { ctx, pi, notify, config, issueNum, issueTitle } = runCtx;

	// Pipeline main loop
	ctx.ui.setStatus("supervisor", "Setting up pipeline...");
	runCtx.stageState = createStageState(runCtx.loopItem.status || "Unknown");
	runCtx.loopStatus = runCtx.stageState.loopStatus;

	// Create worktree before loop — available for ALL agents (researcher, architect, developer, auditor).
	// This ensures temp files (researcher JSON findings) go to worktree, not main repo,
	// and worktree-sandbox extension activates for all agents.
	runCtx.worktreeBranch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

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

	return true;
}

// Worktree creation + dependency install + crash-cleanup registration.
async function createPipelineWorktree(runCtx: RunContext): Promise<boolean> {
	const { ctx, pi, config, notify, issueNum, issueTitle } = runCtx;

	ctx.ui.setStatus("supervisor", "Creating worktree...");
	getDebugLogger().info("handler", "Creating worktree", {
		branch: runCtx.worktreeBranch,
		base: config.worktreeBase,
	});
	const createResult = await createWorktree(
		pi,
		ctx.cwd,
		config.worktreeBase!,
		runCtx.worktreeBranch!,
		config.defaultBranch!,
		notify,
	);
	if (!createResult.ok) {
		ctx.ui.notify(`Failed to create worktree: ${createResult.error}`, "error");
		getDebugLogger().error("handler", "Worktree creation failed", {
			error: createResult.error,
		});
		runCtx.collector.push("worktree", "error", `Failed to create worktree: ${createResult.error}`);
		runCtx.worktreePath = undefined;
		// Don't continue without a worktree — send error and stop
		sendPipelineError(
			pi,
			ctx,
			runCtx.agentResults,
			issueNum,
			issueTitle,
			config,
			createResult.error,
			runCtx.stageState.gateFailureHistory,
		);
		return false;
	}
	runCtx.worktreePath = createResult.value;

	ctx.ui.setStatus("supervisor", "Installing worktree dependencies...");
	const depsResult = await installWorktreeDeps(pi, ctx.cwd, runCtx.worktreePath, notify);
	if (!depsResult.ok) {
		runCtx.collector.push("worktree", "warn", `npm ci failed: ${depsResult.error}`);
	}
	getDebugLogger().info("handler", "Worktree ready", { worktreePath: runCtx.worktreePath });

	// ── Signal Handlers for Crash Cleanup ──────────────────────────
	// Register before pipeline loop so accidental process termination
	// (SIGTERM from orchestrator, SIGINT from Ctrl+C) still cleans up
	// the worktree. Unregister in finally block below.
	{
		const cleanupDeps: CleanupOnExitDeps = {
			worktreePath: runCtx.worktreePath,
			worktreeBranch: runCtx.worktreeBranch,
			pi,
			cwd: ctx.cwd,
			notify,
			debugLogger: getDebugLogger(),
		};
		runCtx.crashCleanup = setupCrashCleanup(cleanupDeps);
		getDebugLogger().info("handler", "Crash cleanup handlers registered (SIGTERM/SIGINT)");
	}
	return true;
}
