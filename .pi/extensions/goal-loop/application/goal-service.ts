// ─── GoalService — the only orchestrator ─────────────────────────
// Every side effect of goal mode goes through this class, in one order:
// record → worktree → branch → commit → draft PR → ready → complete.
// Adapters translate; they never decide policy. The ordering contract of
// `decideBoundary` lives in the domain, not here.
//
// Lifecycle note (R5): a rollover starts a NEW runtime generation (a plain
// `runtime.start` call) instead of replacing the Pi session from a lifecycle
// handler — session replacement from `agent_before_settle` can deadlock.

import { failure, type NotifyFn, type Result } from "../../shared/result.ts";
import {
	describeDecision,
	decideBoundary,
	type BoundaryDecision,
} from "../domain/boundary-policy.ts";
import {
	appendSteering,
	boundQuestions,
	goalReadiness,
	reviseCriteria,
} from "../domain/criteria.ts";
import {
	createGoalRecord,
	makeGoalId,
	transitionTo,
	type AcceptanceCriterion,
	type GoalRecord,
	type GoalStatus,
	type VerificationResult,
} from "../domain/goal-record.ts";
import type { GoalLoopSettings } from "../config/goal-loop-settings.ts";
import type {
	CheckRunner,
	GoalAgentRuntime,
	GoalStore,
	GoalWorkspace,
	PullRequestPort,
	ResolvedGoalModel,
	WorkspaceOutcome,
} from "./ports.ts";

const SOURCE = "goal-loop";

/** Effective configuration for one run. */
export interface GoalRuntimeConfig {
	settings: GoalLoopSettings;
	model: ResolvedGoalModel;
}

export interface GoalServiceDeps {
	store: GoalStore;
	workspace: GoalWorkspace;
	pr: PullRequestPort;
	runtime: GoalAgentRuntime;
	checks: CheckRunner;
	/** Load + validate settings, resolve the model, gate capacity (R6). */
	loadConfig: () => Result<GoalRuntimeConfig>;
	notify?: NotifyFn;
	now?: () => Date;
	/** Branch checked out in the original checkout — the PR base (R3.AC2). */
	baseBranch: () => Promise<Result<string>>;
	/** `owner/repo` for PR operations. */
	repo: string;
}

/** What the agent submits when it has finished clarifying. */
export interface ClarificationSubmission {
	/** The agent judges the goal clear, reachable and verifiable. */
	ready: boolean;
	/** Focused questions, bounded to five by the service. */
	questions?: string[];
	/** Restated measurable goal. */
	clarifiedGoal?: string;
	criteria?: AcceptanceCriterion[];
	/** The agent judged the goal unreachable. */
	reachable?: boolean;
}

export interface ClarificationOutcome {
	record: GoalRecord;
	/** Questions the user must answer; empty once the goal started. */
	questions: string[];
	/** True when the worktree was created and the first generation started. */
	started: boolean;
}

export interface BoundaryOutcome {
	record: GoalRecord;
	decision: BoundaryDecision;
	/** User-facing one-liner. */
	message: string;
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
	private readonly deps: GoalServiceDeps;
	private record: GoalRecord | null = null;
	private lastSavedCheckpoint: string | null = null;
	/** The next-action the agent reported for the following iteration. */
	private pendingNextAction = "";

	constructor(deps: GoalServiceDeps) {
		this.deps = deps;
	}

	// ─── Introspection ──────────────────────────────────────────

	/** The in-memory record, or null when no goal was started in this session. */
	current(): GoalRecord | null {
		return this.record;
	}

	/** True when a goal exists and has not reached a terminal status. */
	hasActiveGoal(): boolean {
		const status = this.record?.status;
		return status !== undefined && status !== "complete" && status !== "cancelled";
	}

	private now(): Date {
		return this.deps.now ? this.deps.now() : new Date();
	}

	private notify(level: "info" | "error", message: string): void {
		if (level === "info") this.deps.notify?.info(message);
		else this.deps.notify?.error(message);
	}

	// ─── Persistence ────────────────────────────────────────────

	/**
	 * Write the record with a fresh checkpoint stamp.
	 *
	 * A write failure is returned, never swallowed: the caller pauses the loop
	 * and reports the last checkpoint that DID reach disk (R2.AC4).
	 */
	private async persist(record: GoalRecord): Promise<Result<GoalRecord>> {
		const stamped: GoalRecord = {
			...record,
			lastCheckpoint: this.now().toISOString(),
			nextAction: this.pendingNextAction || record.nextAction,
		};
		const written = await this.deps.store.write(stamped);
		if (!written.ok) {
			return failure(
				`goal state write failed: ${written.error} — last saved checkpoint: ${
					this.lastSavedCheckpoint ?? "(none)"
				}`,
				SOURCE,
			);
		}
		this.record = stamped;
		this.lastSavedCheckpoint = stamped.lastCheckpoint;
		return { ok: true, value: stamped };
	}

	/** Persist, and on failure pause in memory while surfacing the error. */
	private async persistOrPause(record: GoalRecord): Promise<Result<GoalRecord>> {
		const persisted = await this.persist(record);
		if (persisted.ok) return persisted;
		// Fail closed: keep the in-memory record paused so no further iteration
		// can start from state that never reached disk.
		if (this.record) {
			this.record = { ...this.record, status: "paused", blocker: persisted.error };
		}
		this.notify("error", persisted.error);
		return persisted;
	}

	// ─── Start (R1, R2, R6) ─────────────────────────────────────

	/**
	 * `/goal <request>`: validate configuration, refuse a second active goal,
	 * and create the `clarifying` record.
	 *
	 * No worktree, branch or session is created here (R1.AC1/R1.AC2).
	 */
	async start(request: string): Promise<Result<GoalRecord>> {
		if (this.hasActiveGoal()) {
			return failure(
				`a goal is already active (${this.record!.id}) — run /goal stop before starting another`,
				SOURCE,
			);
		}
		const trimmed = request.trim();
		if (!trimmed) {
			return failure("usage: /goal <description>", SOURCE);
		}

		const config = this.deps.loadConfig();
		if (!config.ok) {
			return failure(`cannot start goal: ${config.error}`, SOURCE);
		}

		const existing = await this.deps.store.list();
		if (!existing.ok) {
			return failure(`cannot read existing goal records: ${existing.error}`, SOURCE);
		}
		const active = existing.value.filter(
			(r) => r.status !== "complete" && r.status !== "cancelled",
		);
		if (active.length > 0) {
			return failure(
				`a goal is already active (${active[0]!.id}) — run /goal stop before starting another`,
				SOURCE,
			);
		}

		const lock = await this.deps.store.acquire();
		if (!lock.ok) {
			return failure(`cannot lock the goal record directory: ${lock.error}`, SOURCE);
		}

		const created = createGoalRecord({
			id: makeGoalId(trimmed, this.now()),
			request: trimmed,
			config: {
				model: config.value.settings.model,
				rolloverTokens: config.value.settings.contextRolloverTokens,
				maxIterations: config.value.settings.maxIterations,
			},
			now: this.now(),
		});

		const persisted = await this.persist(created);
		if (!persisted.ok) {
			// R2.AC4: do not start when the initial record cannot be created.
			await this.deps.store.release();
			return persisted;
		}
		return { ok: true, value: persisted.value };
	}

	// ─── Clarification gate (R1) ────────────────────────────────

	/**
	 * Apply one clarification round.
	 *
	 * `ready: false` (or unreachable, or invalid criteria) keeps `clarifying`
	 * and returns the bounded questions — no worktree, no session (R1.AC2).
	 * `ready: true` with a valid criterion set starts work without any further
	 * confirmation step (R1.AC3).
	 */
	async submitClarification(input: ClarificationSubmission): Promise<Result<ClarificationOutcome>> {
		if (!this.record) return failure("no goal is being clarified", SOURCE);
		if (this.record.status !== "clarifying") {
			return failure(
				`goal ${this.record.id} is not clarifying (status: ${this.record.status})`,
				SOURCE,
			);
		}

		const questions = boundQuestions(input.questions ?? []);
		const clarifiedGoal = (input.clarifiedGoal ?? this.record.clarifiedGoal).trim();
		const criteria = input.criteria ?? this.record.criteria;
		const candidate: GoalRecord = { ...this.record, clarifiedGoal, criteria };

		const readiness = goalReadiness(candidate);
		const blocked = input.ready === false || input.reachable === false || !readiness.ready;

		if (blocked) {
			const problems =
				input.reachable === false
					? [
							"the goal is not reachable with the available repository and tools",
							...readiness.problems,
						]
					: readiness.problems;
			const persisted = await this.persist({
				...candidate,
				nextAction: problems[0] ?? questions[0] ?? "answer the clarification questions",
			});
			if (!persisted.ok) return persisted;
			const surfaced = questions.length > 0 ? questions : problems;
			return {
				ok: true,
				value: { record: persisted.value, questions: surfaced, started: false },
			};
		}

		// Ready: activate, then worktree, then first generation. No prompt in
		// between (R1.AC3).
		const activated = transitionTo(candidate, "active");
		this.pendingNextAction = "start the first work iteration";
		const activePersisted = await this.persist(activated);
		if (!activePersisted.ok) return activePersisted;

		return await this.beginWork(activePersisted.value, questions);
	}

	/** Create the worktree and start the first generation. */
	private async beginWork(
		record: GoalRecord,
		questions: string[],
	): Promise<Result<ClarificationOutcome>> {
		const prepared = await this.deps.workspace.prepare({
			goalId: record.id,
			branch: goalBranchName(record),
		});
		if (!prepared.ok) {
			return await this.pauseWithBlocker(record, questions, prepared.error);
		}
		const outcome: WorkspaceOutcome = prepared.value;
		if (!outcome.clean) {
			// R3.AC2: the dirty checkout is left untouched.
			return await this.pauseWithBlocker(record, questions, outcome.reason);
		}

		const withWorkspace: GoalRecord = {
			...record,
			worktree: outcome.path,
			branch: outcome.branch,
			inFlight: true,
		};
		const workspacePersisted = await this.persistOrPause(withWorkspace);
		if (!workspacePersisted.ok) return workspacePersisted;

		const started = await this.deps.runtime.start({
			goalId: withWorkspace.id,
			worktree: outcome.path,
			model: withWorkspace.config.model,
			prompt: buildGenerationPrompt(withWorkspace),
			generation: withWorkspace.generation,
		});
		if (!started.ok) {
			return await this.pauseWithBlocker(withWorkspace, questions, started.error);
		}
		this.notify(
			"info",
			`goal ${withWorkspace.id} started — worktree ${outcome.path}, branch ${outcome.branch}`,
		);
		return { ok: true, value: { record: withWorkspace, questions: [], started: true } };
	}

	/** Record a blocker, pause, and keep the worktree/branch intact. */
	private async pauseWithBlocker(
		record: GoalRecord,
		questions: string[],
		blocker: string,
	): Promise<Result<ClarificationOutcome>> {
		const paused = transitionTo(record, "paused");
		const persisted = await this.persist({ ...paused, blocker });
		if (!persisted.ok) return persisted;
		this.notify("error", `goal paused: ${blocker}`);
		return { ok: true, value: { record: persisted.value, questions, started: false } };
	}

	// ─── Iteration + verification (R4, R7) ──────────────────────

	/** Apply the agent's iteration report (summary, next action, blocker). */
	async reportIteration(report: IterationReport): Promise<Result<GoalRecord>> {
		if (!this.record) return failure("no active goal", SOURCE);
		const updated: GoalRecord = {
			...this.record,
			blocker: report.blocker ?? this.record.blocker,
		};
		this.pendingNextAction = report.nextAction || report.summary;
		return await this.persist(updated);
	}

	/**
	 * The single boundary entry point, shared by `agent_before_settle`, the
	 * post-iteration check and the rollover driver.
	 *
	 * Order: checkpoint the iteration → verify from scratch → decide → apply.
	 */
	async onBoundary(): Promise<Result<BoundaryOutcome>> {
		if (!this.record) return failure("no active goal", SOURCE);
		if (!this.hasActiveGoal()) {
			return failure(`goal ${this.record.id} is ${this.record.status}`, SOURCE);
		}

		// 1. Post-iteration checkpoint (write #1 of two). The compaction flag is
		// consumed here so it is durable before any decision relies on it.
		const compactionSeen = this.deps.runtime.takeCompactionSeen();
		const counted: GoalRecord = {
			...this.record,
			iterations: this.record.iterations + 1,
			windowIterations: this.record.windowIterations + 1,
			inFlight: false,
			compactionSeen: compactionSeen || this.record.compactionSeen,
		};
		const checkpointed = await this.persistOrPause(counted);
		if (!checkpointed.ok) return checkpointed;

		// 2. Verify every criterion from scratch — stored evidence never counts.
		const verification = await this.verifyAll(checkpointed.value);
		const withEvidence: GoalRecord = {
			...checkpointed.value,
			verification: verification.results,
			blocker: verification.blocker ?? checkpointed.value.blocker,
		};
		// 3. Publish (R3.AC3): once a work iteration landed on a branch, a draft PR
		// exists for review. The decision below uses the PR state observed BEFORE
		// publication, so a PR opened at this boundary never satisfies "PR exists"
		// for the same boundary — completion is judged on evidence that existed
		// when the criteria were checked.
		const prStateBefore = withEvidence.pr?.state ?? "none";
		let recordForApply: GoalRecord = withEvidence;
		if (prStateBefore === "none" && withEvidence.branch && withEvidence.iterations >= 1) {
			const published = await this.publish();
			if (!published.ok) return published;
			if (published.value.status === "paused") {
				const decision: BoundaryDecision = {
					kind: "pause",
					reason: "blocked",
					detail: published.value.blocker ?? "pull request could not be opened",
				};
				return {
					ok: true,
					value: { record: published.value, decision, message: describeDecision(decision) },
				};
			}
			// Carry the PR forward so the decision write does not drop it.
			recordForApply = { ...withEvidence, pr: published.value.pr };
		}

		// 4. Decide on the pre-publication evidence.
		const decision = decideBoundary({
			verification: recordForApply.verification,
			prState: prStateBefore,
			tokens: this.deps.runtime.contextTokens(),
			rolloverTokens: recordForApply.config.rolloverTokens,
			compactionSeen: recordForApply.compactionSeen,
			iterations: recordForApply.iterations,
			maxIterations: recordForApply.config.maxIterations,
			blocker: recordForApply.blocker,
		});

		// 5. Apply (write #2 of two).
		const applied = await this.applyDecision(recordForApply, decision);
		if (!applied.ok) return applied;
		return {
			ok: true,
			value: {
				record: applied.value,
				decision,
				message: describeDecision(decision),
			},
		};
	}

	/** Run every criterion's verifier; a runner failure is a blocker. */
	private async verifyAll(
		record: GoalRecord,
	): Promise<{ results: VerificationResult[]; blocker: string | null }> {
		const worktree = record.worktree;
		if (!worktree) {
			return { results: [], blocker: "no worktree to verify against" };
		}
		const results: VerificationResult[] = [];
		for (const criterion of record.criteria) {
			let outcome;
			try {
				outcome = await this.deps.checks.run(criterion, worktree);
			} catch (err: unknown) {
				return {
					results,
					blocker: `verification could not run for ${criterion.id}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				};
			}
			if (!outcome.ok) {
				return {
					results,
					blocker: `verification could not run for ${criterion.id}: ${outcome.error}`,
				};
			}
			results.push({
				criterionId: criterion.id,
				result: outcome.value.result,
				evidenceRef: outcome.value.evidenceRef,
				checkedAt: this.now().toISOString(),
			});
		}
		return { results, blocker: null };
	}

	/** Apply one boundary decision. */
	private async applyDecision(
		record: GoalRecord,
		decision: BoundaryDecision,
	): Promise<Result<GoalRecord>> {
		switch (decision.kind) {
			case "complete":
				return await this.completeGoal(record);
			case "pause":
				return await this.pauseActive(record, decision.detail);
			case "pause-cap":
				return await this.pauseActive(
					record,
					`iteration limit reached (${record.config.maxIterations}) — approve /goal resume to continue`,
				);
			case "rollover":
				return await this.rollover(record);
			case "continue":
				return await this.persistOrPause(record);
		}
	}

	/** Pause an active goal with a blocker; worktree and branch remain. */
	private async pauseActive(record: GoalRecord, blocker: string): Promise<Result<GoalRecord>> {
		const paused = transitionTo(record, "paused");
		const persisted = await this.persistOrPause({ ...paused, blocker });
		if (!persisted.ok) return persisted;
		this.notify("error", `goal paused: ${blocker}`);
		return persisted;
	}

	/**
	 * Complete the goal (R3.AC4): publish the PR as ready for review, mark the
	 * record complete, release the lock. Never merges.
	 */
	private async completeGoal(record: GoalRecord): Promise<Result<GoalRecord>> {
		const verifying = transitionTo(record, "verifying");
		let pr = verifying.pr;
		if (pr && pr.state === "draft") {
			const ready = await this.deps.pr.markReadyForReview(pr.nodeId);
			if (!ready.ok) {
				return await this.pauseActive(
					transitionTo(verifying, "active"),
					`could not mark PR #${pr.number} ready for review: ${ready.error}`,
				);
			}
			pr = { ...pr, state: "open" };
		}
		const completed = transitionTo({ ...verifying, pr, blocker: null }, "complete");
		this.pendingNextAction = "";
		const persisted = await this.persistOrPause(completed);
		if (!persisted.ok) return persisted;
		await this.deps.runtime.dispose();
		await this.deps.store.release();
		this.notify("info", `goal ${completed.id} complete — pull request left for review`);
		return persisted;
	}

	/**
	 * Rollover (R5.AC3): checkpoint, then start a fresh generation in the same
	 * worktree from the record alone. Counters stay cumulative.
	 */
	private async rollover(record: GoalRecord): Promise<Result<GoalRecord>> {
		const rolled: GoalRecord = {
			...record,
			resets: record.resets + 1,
			generation: record.generation + 1,
			windowIterations: 0,
			compactionSeen: false,
			inFlight: true,
		};
		this.pendingNextAction = record.nextAction || "continue the goal from this record";
		const checkpointed = await this.persistOrPause(rolled);
		if (!checkpointed.ok) return checkpointed;

		const started = await this.deps.runtime.start({
			goalId: checkpointed.value.id,
			worktree: checkpointed.value.worktree ?? "",
			model: checkpointed.value.config.model,
			prompt: buildGenerationPrompt(checkpointed.value),
			generation: checkpointed.value.generation,
		});
		if (!started.ok) {
			return await this.pauseActive(
				checkpointed.value,
				`fresh session could not start: ${started.error}`,
			);
		}
		this.notify(
			"info",
			`checkpoint saved, fresh session started (reset ${checkpointed.value.resets})`,
		);
		return checkpointed;
	}

	// ─── Publication (R3) ───────────────────────────────────────

	/** Open the draft PR after the first goal commit, or refresh its body. */
	async publish(): Promise<Result<GoalRecord>> {
		if (!this.record) return failure("no active goal", SOURCE);
		if (!this.record.branch) {
			return failure("goal has no branch yet — nothing to publish", SOURCE);
		}
		const existing = this.record.pr;
		if (existing) {
			const updated = await this.deps.pr.updateBody({
				number: existing.number,
				body: buildPrBody(this.record),
			});
			if (!updated.ok)
				return await this.pauseActive(this.record, `PR update failed: ${updated.error}`);
			return await this.persistOrPause(this.record);
		}
		const base = await this.deps.baseBranch();
		if (!base.ok) {
			return await this.pauseActive(
				this.record,
				`cannot resolve the pull-request base branch: ${base.error}`,
			);
		}
		const opened = await this.deps.pr.openDraft({
			branch: this.record.branch,
			base: base.value,
			title: `goal: ${this.record.clarifiedGoal || this.record.request}`,
			body: buildPrBody(this.record),
		});
		if (!opened.ok) {
			return await this.pauseActive(this.record, `PR creation failed: ${opened.error}`);
		}
		const withPr: GoalRecord = {
			...this.record,
			pr: { number: opened.value.number, nodeId: opened.value.nodeId, state: "draft" },
		};
		const persisted = await this.persistOrPause(withPr);
		if (!persisted.ok) return persisted;
		this.notify("info", `draft PR #${opened.value.number} opened for ${withPr.branch}`);
		return persisted;
	}

	// ─── Steering, revision, stop (R4, R7.AC2) ──────────────────

	/** Ordinary message during an active goal: steer, never rewrite criteria. */
	async steer(message: string): Promise<Result<GoalRecord>> {
		if (!this.record || !this.hasActiveGoal()) {
			return failure("no active goal to steer", SOURCE);
		}
		const steered = appendSteering(this.record, message);
		if (steered === this.record) return { ok: true, value: this.record };
		const persisted = await this.persistOrPause(steered);
		if (!persisted.ok) return persisted;
		const forwarded = await this.deps.runtime.steer(message);
		if (!forwarded.ok) {
			return failure(`could not forward steering message: ${forwarded.error}`, SOURCE);
		}
		return persisted;
	}

	/**
	 * Record an ordinary user message while the goal is `clarifying`.
	 *
	 * The message is clarification input, not a criterion change: it is appended
	 * to the record so a context reset does not lose the user's answer (R1.AC2,
	 * R2.AC3). Criteria change only through the clarification submission.
	 */
	async recordClarificationMessage(message: string): Promise<Result<GoalRecord>> {
		if (!this.record) return failure("no goal is being clarified", SOURCE);
		if (this.record.status !== "clarifying") {
			return failure(`goal ${this.record.id} is not clarifying`, SOURCE);
		}
		return await this.persistOrPause(appendSteering(this.record, message));
	}

	/** `/goal revise`: replace criteria and re-enter clarification. */
	async revise(input: {
		criteria: AcceptanceCriterion[];
		clarifiedGoal?: string;
	}): Promise<Result<GoalRecord>> {
		if (!this.record) return failure("no goal to revise", SOURCE);
		let revised: GoalRecord;
		try {
			revised = reviseCriteria(this.record, input.criteria, input.clarifiedGoal);
		} catch (err: unknown) {
			return failure(err instanceof Error ? err.message : String(err), SOURCE);
		}
		this.pendingNextAction = "re-clarify the revised goal";
		return await this.persistOrPause(revised);
	}

	/**
	 * `/goal stop` (R1.AC4, R7.AC2): abort the running generation, save the
	 * final status, and start nothing else.
	 */
	async stop(): Promise<Result<GoalRecord>> {
		if (!this.record) return failure("no goal is running", SOURCE);
		if (!this.hasActiveGoal()) {
			return failure(`goal ${this.record.id} is already ${this.record.status}`, SOURCE);
		}
		const aborted = await this.deps.runtime.abort();
		if (!aborted.ok) {
			this.notify("error", `could not abort the running session: ${aborted.error}`);
		}
		const cancelled: GoalRecord = {
			...transitionTo(this.record, "cancelled"),
			inFlight: false,
		};
		this.pendingNextAction = "";
		const persisted = await this.persistOrPause(cancelled);
		await this.deps.runtime.dispose();
		await this.deps.store.release();
		return persisted;
	}

	/** `/goal resume [--approve]`: un-pause and start the next generation. */
	async resume(input: { approve: boolean }): Promise<Result<GoalRecord>> {
		if (!this.record) return failure("no goal to resume", SOURCE);
		if (this.record.status !== "paused") {
			return failure(`goal ${this.record.id} is ${this.record.status}, not paused`, SOURCE);
		}
		if (!input.approve) {
			return failure(
				`goal ${this.record.id} is paused (${this.record.blocker ?? "unknown blocker"}) — ` +
					"run /goal resume --approve to continue",
				SOURCE,
			);
		}
		const config = this.deps.loadConfig();
		if (!config.ok) return failure(`cannot resume goal: ${config.error}`, SOURCE);
		const resumed: GoalRecord = {
			...transitionTo(this.record, "active"),
			blocker: null,
			config: {
				model: config.value.settings.model,
				rolloverTokens: config.value.settings.contextRolloverTokens,
				maxIterations: config.value.settings.maxIterations,
			},
		};
		this.pendingNextAction = resumed.nextAction || "continue the goal";
		const persisted = await this.persistOrPause(resumed);
		if (!persisted.ok) return persisted;
		const started = await this.deps.runtime.start({
			goalId: resumed.id,
			worktree: resumed.worktree ?? "",
			model: resumed.config.model,
			prompt: buildGenerationPrompt(resumed),
			generation: resumed.generation,
		});
		if (!started.ok) {
			return await this.pauseActive(resumed, `fresh session could not start: ${started.error}`);
		}
		return persisted;
	}

	// ─── Cleanup (R3.AC5) ───────────────────────────────────────

	/**
	 * Remove the worktree and branch, but only on explicit confirmation. A PR
	 * that is merged or closed never triggers cleanup by itself.
	 */
	async cleanup(input: { confirmed: boolean }): Promise<Result<void>> {
		if (!this.record) return failure("no goal to clean up", SOURCE);
		if (!this.record.worktree) {
			return failure(`goal ${this.record.id} has no worktree to remove`, SOURCE);
		}
		const removed = await this.deps.workspace.cleanupWorktree({
			path: this.record.worktree,
			confirmed: input.confirmed,
		});
		if (!removed.ok) return removed;
		this.notify("info", `worktree ${this.record.worktree} removed`);
		return removed;
	}

	// ─── Status (R4.AC3) ────────────────────────────────────────

	/** `/goal status`: the loop's full visible state. */
	status(): string {
		const record = this.record;
		if (!record) return "no active goal";
		const lines: string[] = [
			`goal ${record.id}`,
			`status: ${record.status}`,
			`iterations: ${record.iterations}`,
			`resets: ${record.resets}`,
			`worktree: ${record.worktree ?? "(none)"}`,
			`branch: ${record.branch ?? "(none)"}`,
			`pull request: ${record.pr ? `#${record.pr.number} (${record.pr.state})` : "(none)"}`,
		];
		if (record.blocker) lines.push(`blocker: ${record.blocker}`);
		if (record.criteria.length === 0) {
			lines.push("criteria: (none yet)");
		} else {
			lines.push("criteria:");
			for (const criterion of record.criteria) {
				const result = record.verification.find((v) => v.criterionId === criterion.id);
				lines.push(
					`  - ${criterion.id}: ${result ? result.result : "unchecked"} — ${criterion.text}`,
				);
			}
		}
		return lines.join("\n");
	}
}

/** The branch a goal's worktree carries. */
export function goalBranchName(record: GoalRecord): string {
	return `goal/${record.id}`;
}

/**
 * The fresh-session prompt for one generation. Derived from the record ONLY —
 * no prior transcript, message history or summary is passed (R5.AC3).
 */
export function buildGenerationPrompt(record: GoalRecord): string {
	const criteria =
		record.criteria.length === 0
			? "(none yet)"
			: record.criteria
					.map((c) => {
						const verifier =
							c.verifier.kind === "command"
								? `command: ${c.verifier.argv.join(" ")} (expect exit ${c.verifier.expectExit})`
								: `inspect: ${c.verifier.instruction}`;
						return `- ${c.id}: ${c.text} [${verifier}]`;
					})
					.join("\n");
	return [
		`Continue goal ${record.id}.`,
		"",
		"## Clarified goal",
		record.clarifiedGoal || record.request,
		"",
		"## Acceptance criteria",
		criteria,
		"",
		"## Next action",
		record.nextAction || "continue the goal from this record",
		"",
		`Work only in the goal worktree: ${record.worktree ?? "(none)"} (branch ${record.branch ?? "(none)"}).`,
		"Do not edit the Markdown goal record; report progress through goal_report_iteration.",
	].join("\n");
}

/** PR body for the draft PR — acceptance criteria plus verification evidence. */
export function buildPrBody(record: GoalRecord): string {
	const lines = [
		`Goal: ${record.clarifiedGoal || record.request}`,
		"",
		`Goal record: \`ignore/goals/${record.id}.md\` (not committed)`,
		"",
		"## Acceptance criteria",
		"",
	];
	for (const c of record.criteria) lines.push(`- [ ] ${c.id}: ${c.text}`);
	lines.push("", "## Verification evidence", "");
	if (record.verification.length === 0) {
		lines.push("(no verification run yet)");
	} else {
		for (const v of record.verification) {
			lines.push(`- ${v.criterionId}: ${v.result} — ${v.evidenceRef}`);
		}
	}
	return lines.join("\n");
}
