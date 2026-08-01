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
}

// ─── Resolved-By Info Fetcher ─────────────────────────────────────
// Fetches the resolving commit SHA and PR number for the default branch.
// Called when case 2 (close with named resolution) is triggered.
// Uses git log for the latest commit SHA and the port to find merged PRs.
// Fail-soft: returns placeholder values if git/API calls fail.

export async function fetchResolvedByInfo(
	execFn: (
		cmd: string,
		args: string[],
		opts?: Record<string, unknown>,
	) => Promise<{ code: number; stdout: string; stderr: string }>,
	worktreePath: string,
	baseBranch: string,
	port: GitHubPort,
	issueNum: number,
	repo: string,
): Promise<{ sha: string; prNumber: number; source: string }> {
	let sha = "";
	let prNumber = 0;
	let source = "main-branch";

	// 1. Get the latest commit SHA from the default branch
	try {
		const shaResult = await execFn("git", ["log", "-1", baseBranch, "--format=%H"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		if (shaResult.code === 0 && shaResult.stdout?.trim()) {
			sha = shaResult.stdout.trim();
		}
	} catch {
		// Non-fatal — proceed with empty sha
	}

	// 2. Try to find a merged PR that references this issue for the PR number
	try {
		const refs = await port.getClosingPrsForIssue(issueNum, repo);
		// Look for a closing-keyword PR (likely merged/main PR, not branch-head)
		const closingRef = refs.find((r) => r.source === "closing-keyword");
		if (closingRef) {
			prNumber = closingRef.number;
			source = closingRef.source;
			if (closingRef.sha) {
				sha = closingRef.sha;
			}
		} else if (refs.length > 0) {
			// Fall back to first PR ref
			prNumber = refs[0].number;
			source = refs[0].source;
			if (refs[0].sha) {
				sha = refs[0].sha;
			}
		}
	} catch {
		// Non-fatal — proceed with commit SHA only
	}

	// Use the actual commit SHA from git log as the authoritative value
	// (overrides any SHA from the PR which might be a merge commit)
	if (!sha) {
		sha = "main";
	}

	return { sha, prNumber, source };
}
