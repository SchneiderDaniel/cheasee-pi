// ─── Pull-request publication (R3.AC3/AC4) ──────────────────────
// The draft PR is opened after the first goal commit and refreshed as work
// proceeds. Un-drafting is GraphQL-only: the REST `pulls.update` call silently
// ignores `draft: false`, so a naive un-draft reports success while the PR
// stays a draft. Nothing here merges or closes a PR.

import { failure, type NotifyFn, type Result } from "../../shared/result.ts";
import type { GoalRecord } from "../domain/goal-record.ts";
import { buildPrBody } from "./goal-prompts.ts";
import { pauseForUser } from "./goal-launch.ts";
import type { RecordKeeper } from "./record-keeper.ts";
import type { PullRequestPort } from "./ports.ts";

const SOURCE = "goal-loop";

/** Ports publication needs. */
export interface PublicationDeps {
	pr: PullRequestPort;
	/** Branch checked out in the original checkout — the PR base. */
	baseBranch: () => Promise<Result<string>>;
	notify?: NotifyFn;
}

/** Draft-PR creation, body refresh and ready-for-review. */
export class GoalPublisher {
	private readonly keeper: RecordKeeper;
	private readonly deps: PublicationDeps;

	constructor(keeper: RecordKeeper, deps: PublicationDeps) {
		this.keeper = keeper;
		this.deps = deps;
	}

	/** Open the draft PR after the first goal commit, or refresh its body. */
	async publish(): Promise<Result<GoalRecord>> {
		const record = this.keeper.current();
		if (!record) return failure("no active goal", SOURCE);
		if (!record.branch) return failure("goal has no branch yet — nothing to publish", SOURCE);
		if (record.pr) return await this.refreshBody(record);
		return await this.openDraft(record);
	}

	/** Existing PR: update the body, never open a second one. */
	private async refreshBody(record: GoalRecord): Promise<Result<GoalRecord>> {
		const pr = record.pr!;
		const updated = await this.deps.pr.updateBody({ number: pr.number, body: buildPrBody(record) });
		if (!updated.ok) {
			const blocker = `PR update failed: ${updated.error}`;
			return await pauseForUser(this.keeper, this.deps.notify, record, blocker);
		}
		return await this.keeper.persistOrPause(record);
	}

	/** First PR: resolve the base branch, then create it as a draft. */
	private async openDraft(record: GoalRecord): Promise<Result<GoalRecord>> {
		const base = await this.deps.baseBranch();
		if (!base.ok) {
			const blocker = `cannot resolve the pull-request base branch: ${base.error}`;
			return await pauseForUser(this.keeper, this.deps.notify, record, blocker);
		}
		const opened = await this.deps.pr.openDraft({
			branch: record.branch!,
			base: base.value,
			title: `goal: ${record.clarifiedGoal || record.request}`,
			body: buildPrBody(record),
		});
		if (!opened.ok) {
			const failureText = `PR creation failed: ${opened.error}`;
			return await pauseForUser(this.keeper, this.deps.notify, record, failureText);
		}
		const withPr: GoalRecord = {
			...record,
			pr: { number: opened.value.number, nodeId: opened.value.nodeId, state: "draft" },
		};
		const persisted = await this.keeper.persistOrPause(withPr);
		if (!persisted.ok) return persisted;
		this.deps.notify?.info(`draft PR #${opened.value.number} opened for ${withPr.branch}`);
		return persisted;
	}

	/**
	 * Mark the draft PR ready for review (R3.AC4).
	 *
	 * A missing node id is a failure: the GraphQL mutation cannot run, and
	 * reporting "ready" without it would leave the PR a draft.
	 */
	async markReady(record: GoalRecord): Promise<Result<GoalRecord>> {
		const pr = record.pr;
		if (!pr || pr.state !== "draft") return { ok: true, value: record };
		if (!pr.nodeId) {
			const blocker = `PR #${pr.number} has no GraphQL node id — cannot mark it ready for review`;
			return await pauseForUser(this.keeper, this.deps.notify, record, blocker);
		}
		const ready = await this.deps.pr.markReadyForReview(pr.nodeId);
		if (!ready.ok) {
			const blocker = `could not mark PR #${pr.number} ready for review: ${ready.error}`;
			return await pauseForUser(this.keeper, this.deps.notify, record, blocker);
		}
		return { ok: true, value: { ...record, pr: { ...pr, state: "open" } } };
	}
}
