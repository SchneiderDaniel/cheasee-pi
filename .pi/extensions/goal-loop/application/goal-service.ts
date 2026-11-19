// ─── GoalService — the only orchestrator ─────────────────────────
// Every side effect of goal mode goes through this facade, in one order:
// record → worktree → branch → commit → draft PR → ready → complete.
// Adapters translate; they never decide policy. The ordering contract of
// `decideBoundary` lives in the domain.
//
// The collaborators split that order into cohesive units: `GoalStarter`
// (record), `GoalClarifier` (gate), `BoundaryRunner` (verify + decide),
// `GoalPublisher` (PR), `completeGoal` (ready + complete), `GoalControl`
// (steer/revise/stop/resume/cleanup).

import { failure, type NotifyFn, type Result } from "../../shared/result.ts";
import { renderStatus } from "./goal-prompts.ts";
import { BoundaryRunner, type BoundaryOutcome } from "./goal-boundary.ts";
import { GoalClarifier } from "./goal-clarify.ts";
import { performGoalCleanup } from "./goal-cleanup.ts";
import { GoalControl } from "./goal-control.ts";
import { GoalPublisher } from "./goal-publication.ts";
import {
	GoalStarter,
	type ClarificationOutcome,
	type ClarificationSubmission,
} from "./goal-start.ts";
import { RecordKeeper } from "./record-keeper.ts";
import type {
	AcceptanceCriterion,
	CheckRunner,
	GoalAgentRuntime,
	GoalRecord,
	GoalStore,
	GoalWorkspace,
	LoadGoalConfig,
	PullRequestPort,
} from "./ports.ts";

export type { GoalRuntimeConfig } from "./ports.ts";
export type { ClarificationOutcome, ClarificationSubmission } from "./goal-start.ts";
export type { BoundaryOutcome } from "./goal-boundary.ts";
export { buildGenerationPrompt } from "./goal-prompts.ts";

const SOURCE = "goal-loop";

export interface GoalServiceDeps {
	store: GoalStore;
	workspace: GoalWorkspace;
	pr: PullRequestPort;
	runtime: GoalAgentRuntime;
	checks: CheckRunner;
	/** Load + validate settings, resolve the model, gate capacity (R6). */
	loadConfig: LoadGoalConfig;
	notify?: NotifyFn;
	now?: () => Date;
	/** Branch checked out in the original checkout — the PR base (R3.AC2). */
	baseBranch: () => Promise<Result<string>>;
	/** `owner/repo` for PR operations. */
	repo: string;
}

/** One agent iteration report (from the `goal_report_iteration` tool). */
export interface IterationReport {
	summary: string;
	nextAction: string;
	blocker?: string | null;
}

/**
 * The goal loop's orchestrator.
 *
 * Exactly one goal is active per service instance (one Pi session, R3.AC1); the
 * store's active-record scan catches a second goal from another session.
 */
export class GoalService {
	private readonly keeper: RecordKeeper;
	private readonly starter: GoalStarter;
	private readonly clarifier: GoalClarifier;
	private readonly publisher: GoalPublisher;
	private readonly boundary: BoundaryRunner;
	private readonly control: GoalControl;

	private readonly deps: GoalServiceDeps;

	constructor(deps: GoalServiceDeps) {
		this.deps = deps;
		const now = (): Date => (deps.now ? deps.now() : new Date());
		const shared = {
			store: deps.store,
			workspace: deps.workspace,
			runtime: deps.runtime,
			// Read lazily so a reloaded configuration applies at the next start (R6).
			loadConfig: () => deps.loadConfig(),
			now,
			notify: deps.notify,
		};
		this.keeper = new RecordKeeper(deps.store, now, deps.notify);
		this.starter = new GoalStarter(this.keeper, shared);
		this.clarifier = new GoalClarifier(this.keeper, shared);
		this.control = new GoalControl(this.keeper, shared);
		this.publisher = new GoalPublisher(this.keeper, {
			pr: deps.pr,
			baseBranch: deps.baseBranch,
			notify: deps.notify,
		});
		this.boundary = new BoundaryRunner(this.keeper, {
			checks: deps.checks,
			runtime: deps.runtime,
			store: deps.store,
			publisher: this.publisher,
			notify: deps.notify,
			now,
		});
	}

	// ─── Introspection ──────────────────────────────────────────

	/** The in-memory record, or null when no goal was started in this session. */
	current(): GoalRecord | null {
		return this.keeper.current();
	}

	/** True when a goal exists and has not reached a terminal status. */
	hasActiveGoal(): boolean {
		return this.keeper.hasActiveGoal();
	}

	/** `/goal status`: the loop's full visible state (R4.AC3). */
	status(): string {
		return renderStatus(this.keeper.current());
	}

	// ─── Start + clarification (R1) ─────────────────────────────

	/** `/goal <request>`: record a `clarifying` goal; no worktree yet. */
	async start(request: string): Promise<Result<GoalRecord>> {
		return await this.starter.start(request);
	}

	/** Apply one clarification round; readiness starts work with no prompt. */
	async submitClarification(input: ClarificationSubmission): Promise<Result<ClarificationOutcome>> {
		return await this.clarifier.clarify(input);
	}

	// ─── Iteration, verification, publication (R3, R4, R7) ──────

	/** Apply the agent's iteration report (summary, next action, blocker). */
	async reportIteration(report: IterationReport): Promise<Result<GoalRecord>> {
		const record = this.keeper.current();
		if (!record) return failure("no active goal", SOURCE);
		this.keeper.setNextAction(report.nextAction || report.summary);
		return await this.keeper.persist({ ...record, blocker: report.blocker ?? record.blocker });
	}

	/** The single boundary entry point: settle, post-iteration, rollover. */
	async onBoundary(): Promise<Result<BoundaryOutcome>> {
		return await this.boundary.run();
	}

	/** Open the draft PR or refresh its body. */
	async publish(): Promise<Result<GoalRecord>> {
		return await this.publisher.publish();
	}

	// ─── Controls (R4.AC4, R7.AC2, R3.AC5) ──────────────────────

	/** Ordinary message during an active goal: steer, never rewrite criteria. */
	async steer(message: string): Promise<Result<GoalRecord>> {
		return await this.control.steer(message);
	}

	/** Record an ordinary user message while the goal is `clarifying`. */
	async recordClarificationMessage(message: string): Promise<Result<GoalRecord>> {
		return await this.control.recordClarificationMessage(message);
	}

	/** `/goal revise`: replace criteria and re-enter clarification. */
	async revise(input: {
		criteria: AcceptanceCriterion[];
		clarifiedGoal?: string;
	}): Promise<Result<GoalRecord>> {
		return await this.control.revise(input);
	}

	/** `/goal stop`: abort the generation, save the final status, start nothing. */
	async stop(): Promise<Result<GoalRecord>> {
		return await this.control.stop();
	}

	/** `/goal resume [--approve]`: un-pause and start the next generation. */
	async resume(input: { approve: boolean }): Promise<Result<GoalRecord>> {
		return await this.control.resume(input);
	}

	/** `/goal cleanup --confirm`: remove the worktree on explicit confirmation. */
	async cleanup(input: { confirmed: boolean }): Promise<Result<void>> {
		return await performGoalCleanup({
			keeper: this.keeper,
			workspace: this.deps.workspace,
			notify: this.deps.notify,
			confirmed: input.confirmed,
		});
	}
}
