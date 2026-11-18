// ─── Production backend for one Pi session ──────────────────────
// Wires the adapters to the service. GitHub is resolved lazily by
// `LazyPullRequestPort` so a missing token cannot prevent goal state from being
// recorded — it pauses the goal when a pull request is required (R3.AC5).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { failure, toNotifyFn, type Result } from "../shared/result.ts";
import { resolveModel } from "../shared/model/model-ref.ts";
import type { ExecLike } from "../shared/git/git-exec.ts";
import { resolveCurrentBranch } from "../shared/git/git-query.ts";
import { GoalService, type GoalServiceDeps } from "./application/goal-service.ts";
import type { ModelResolver } from "./application/ports.ts";
import { MarkdownGoalStore } from "./adapters/markdown-goal-store.ts";
import { GitGoalWorkspace } from "./adapters/git-goal-workspace.ts";
import { HarnessCheckRunner } from "./adapters/goal-checks.ts";
import { PiGoalAgentRuntime } from "./adapters/pi-goal-runtime.ts";
import { prepareGoalLoopConfig } from "./config/goal-loop-config.ts";
import { createInspectRunner } from "./inspect-verdict.ts";
import { LazyPullRequestPort } from "./lazy-pull-request.ts";

/** The resolved backend for one Pi session. */
export interface GoalLoopBackend {
	service: GoalService;
	/** Runtime whose compaction flag `session_compact` sets. */
	runtime?: { markCompaction(): void };
}

/** Resolve `provider/model-id` through the shared catalog resolver (R6.AC2). */
const catalogModelResolver: ModelResolver = (ref) => {
	const model = resolveModel(ref) as { id: string; provider: string; contextWindow?: number };
	return {
		id: model.id,
		provider: model.provider,
		contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 0,
	};
};

/** Goal worktrees live beside the checkout, not in `os.tmpdir()` (R3.AC2). */
function goalWorktreeBase(checkoutRoot: string): string {
	return join(checkoutRoot, "..");
}

/** Build the production backend for a session context. */
export function createDefaultBackend(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
): Result<GoalLoopBackend> {
	const checkoutRoot = ctx.cwd;
	const settingsPath = join(checkoutRoot, ".pi", "settings.json");
	const exec: ExecLike = pi.exec.bind(pi);

	const repo = readRepo(settingsPath);
	if (!repo.ok) return repo;

	const runtime = new PiGoalAgentRuntime();
	const deps: GoalServiceDeps = {
		store: new MarkdownGoalStore(checkoutRoot),
		workspace: new GitGoalWorkspace({
			checkoutRoot,
			worktreeBase: goalWorktreeBase(checkoutRoot),
			exec,
		}),
		pr: new LazyPullRequestPort(repo.value),
		runtime,
		checks: new HarnessCheckRunner({ exec, inspect: createInspectRunner(ctx, settingsPath) }),
		loadConfig: () => prepareGoalLoopConfig({ settingsPath, resolve: catalogModelResolver }),
		notify: toNotifyFn({
			hasUI: ctx.hasUI,
			notify: (message, level) => ctx.ui.notify(message, level),
		}),
		baseBranch: () => resolveCurrentBranch(exec, checkoutRoot),
		repo: repo.value,
	};
	return { ok: true, value: { service: new GoalService(deps), runtime } };
}

/** `supervisor.repo` from the project settings — the PR target. */
function readRepo(settingsPath: string): Result<string> {
	let settings: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return failure(`${settingsPath} must contain a JSON object`, "goal-loop");
		}
		settings = parsed as Record<string, unknown>;
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		return failure(`cannot read ${settingsPath}: ${reason}`, "goal-loop");
	}
	const supervisor = settings.supervisor;
	const repo =
		typeof supervisor === "object" && supervisor !== null
			? (supervisor as Record<string, unknown>).repo
			: undefined;
	if (typeof repo !== "string" || !repo.trim()) {
		return failure(
			`no "supervisor.repo" in ${settingsPath} — goal pull requests need a repository`,
			"goal-loop",
		);
	}
	return { ok: true, value: repo };
}
