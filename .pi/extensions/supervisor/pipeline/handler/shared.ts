// ─── Pipeline Handler Package: Shared ─────────────────────────────
// Stateless helpers + the RunContext type threaded through the phases.
// No module-level singletons, no getErrorCollector/getDebugLogger calls
// in fetchResolvedByInfo. Other handler files import this, never each other.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	PipelineAgentResult,
	PrCreationResult,
	FilteredIssueData,
	ProjectField,
	ProjectItem,
	AgentRunner,
} from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import type { ExecFn, NotifyFn } from "../helpers.ts";
import type { StageState } from "../stages/index.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { CrashCleanup } from "../crash-cleanup.ts";

// ─── RunContext ──────────────────────────────────────────────────
// Mutable pipeline state threaded through the phases by reference.
// Replaces the ~15 closure-captured locals of the former megahandler
// (config, port, collector, stageState, loopStatus, agentResults,
// worktreePath, worktreeBranch, prCreationResult, crashCleanup,
// issueTitle, stopReason, experimentalEnabled, filteredData,
// systemPromptOptions). Populated in preparePipelineContext/runPreflight
// (preflight.ts), consumed and mutated by runAgentLoop (agent-loop.ts)
// and runPostPipelinePhase (post-pipeline.ts). Defined here — not in
// index.ts — so the phase modules have zero import cycles.
export interface RunContext {
	args: string | undefined;
	ctx: ExtensionCommandContext;
	pi: ExtensionAPI;
	issueNum: number;
	isDebug: boolean;
	systemPromptOptions?: {
		selectedTools?: string[];
		contextFiles?: string[];
		skills?: string[];
	};
	exec: ExecFn;
	notify: NotifyFn;
	collector: ErrorCollector;

	// Populated by runPreflight before runAgentLoop runs — mirrors the
	// pre-refactor `let config!: SupervisorConfig` definite-assignment idiom.
	config: SupervisorConfig;
	port: GitHubPort;
	issueTitle: string;
	filteredData: FilteredIssueData;
	issueData: Record<string, unknown>;
	stageState: StageState;
	/** Live loop status — the pipeline's current stage (not stageState.loopStatus, which stays at the initial value). */
	loopStatus: string;
	loopItem: ProjectItem;
	fields: ProjectField[];
	statusField: ProjectField;
	projectId: string;
	worktreePath: string | undefined;
	worktreeBranch: string | undefined;

	// Mutated by runAgentLoop / runPostPipelinePhase.
	prCreationResult: PrCreationResult | undefined;
	crashCleanup: CrashCleanup | undefined;
	stopReason: string | undefined;
	agentResults: PipelineAgentResult[];

	// Test injection seam (issue #1472): optional mock agent runner passed
	// through to executeAgent and the PR-readiness gate's developer dispatch.
	// Production callers omit this — undefined means the real runner is used.
	_runner?: AgentRunner;
}

// ─── Resolved-By Info Fetcher ─────────────────────────────────────
// Re-export shim: the symbol's home moved to stages/git-ops.ts (issue
// #1533); this re-export keeps handler-shared.test.mts and any ./shared.ts
// consumer resolving the unchanged import path.

export { fetchResolvedByInfo } from "../stages/git-ops.ts";
