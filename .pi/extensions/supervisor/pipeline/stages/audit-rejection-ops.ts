// ─── Pipeline Stages — loop-back bookkeeping (issue #2044/#1829) ──
// Owns everything a pipeline loop-back persists: post or update the
// supervisor's audit rejection in place, retire the rejections it supersedes,
// post approvals, advance the shared `reject-N` counter, record a CI-gate
// failure on the issue/PR, post the terminal limit blocker, and guard the git
// history that a loop-back may unwind. Split out of auditor-output.ts to stay
// under the 500-line long-file ceiling.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, FilteredIssueData } from "../../config/types.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { GitHubPort } from "../../github/ports.ts";
import type { ExecFn } from "../../../lib/port-types.ts";
import { isHeadOnRemote, upsertDeveloperPr } from "./git-ops.ts";
import {
	countAuditRejections,
	findPriorAuditRejection,
	parseRejectCount,
	rejectLabel,
} from "../../lib/audit-rejections.ts";

// ─── Reject counter (issue #1829) ─────────────────────────────────

/**
 * Advance the `reject-N` label counter by one and retire the previous label.
 *
 * The label is the single durable loop counter shared by auditor rejections and
 * CI-gate loop-backs (issue #1829), so both paths must move it the same way.
 * Throws when the counter cannot be read or written: an uncounted loop-back
 * would let the pipeline spin past `maxRejections`, so the caller must stop
 * instead. A failed removal of the stale label is only a warning — the new
 * label already carries the count.
 *
 * @returns the counter value after the bump (`N+1`).
 */
export async function bumpRejectCounter(
	port: GitHubPort,
	issueNum: number,
	repo: string,
	collector?: ErrorCollector,
): Promise<number> {
	let labels: string[];
	try {
		labels = await port.getIssueLabels(issueNum, repo);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("stages", "error", `Failed to read reject labels: ${msg}`);
		throw new Error(`Failed to read reject labels: ${msg}`);
	}

	const current = parseRejectCount(labels);
	const next = current + 1;
	try {
		await port.addIssueLabel(issueNum, repo, rejectLabel(next));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("stages", "error", `Failed to record reject label: ${msg}`);
		throw new Error(`Failed to record reject label: ${msg}`);
	}

	if (current > 0) {
		try {
			await port.removeIssueLabel(issueNum, repo, rejectLabel(current));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			collector?.push("stages", "warn", `Failed to remove stale reject label: ${msg}`);
		}
	}
	return next;
}

/**
 * Record a CI-gate loop-back (issue #1829 AC1/AC2): bump the shared counter,
 * then post one `## CI Gate Failed` comment naming the red checks on the issue
 * (the PR body carries the same entry through `gateFailureHistory`).
 *
 * Rollback mirrors the audit path: the counter is the only durable record of
 * the increment, so it is written first and removed again when the comment
 * cannot be saved. The error is rethrown — an unrecorded loop-back must stop
 * the pipeline, not run unbounded.
 *
 * @returns the counter value after the bump.
 */
export async function postCiGateRejection(
	issueNum: number,
	config: SupervisorConfig,
	note: string,
	iteration: number,
	collector: ErrorCollector | undefined,
	port: GitHubPort | undefined,
	ctx: ExtensionCommandContext,
): Promise<number> {
	if (!port) {
		collector?.push("stages", "error", "Cannot record CI gate rejection: GitHub port unavailable");
		throw new Error("Cannot record CI gate rejection: GitHub port unavailable");
	}

	const next = await bumpRejectCounter(port, issueNum, config.repo, collector);
	try {
		await port.postIssueComment(issueNum, config.repo, buildCiGateRejectionBody(note, iteration));
		ctx.ui.notify(`CI gate rejection posted on issue #${issueNum} — developer resumes with the red checks.`, "warning");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("stages", "error", `Failed to post CI gate rejection: ${msg}`);
		ctx.ui.notify(`CI gate rejection could not be posted: ${msg}`, "error");
		try {
			await port.removeIssueLabel(issueNum, config.repo, rejectLabel(next));
		} catch (rollbackErr: unknown) {
			const rollbackMsg =
				rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
			collector?.push("stages", "warn", `Failed to roll back reject label: ${rollbackMsg}`);
		}
		throw new Error(`Failed to post CI gate rejection: ${msg}`);
	}
	return next;
}

/** Markdown body for a CI-gate loop-back comment. */
function buildCiGateRejectionBody(note: string, iteration: number): string {
	return [
		"## CI Gate Failed",
		"",
		`CI checks are red on the pushed commit (loop ${iteration}). The issue returns to \`Implementation\` so the red check(s) can be fixed and pushed as new commits on top of the current branch — the gate re-polls the new PR head SHA.`,
		"",
		note.trim(),
		"",
		"Fix the failing check(s), push the fix, and the pipeline retries automatically.",
	].join("\n");
}

/**
 * Post the terminal blocker once the shared loop-back budget is spent
 * (issue #1829 AC2). Never throws: the caller is already stopping, so a failed
 * comment is surfaced (notify + collector) instead of masking the stop.
 */
export async function postRejectionLimitBlocker(
	port: GitHubPort | undefined,
	issueNum: number,
	repo: string,
	count: number,
	lastGateNote: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
	if (!port) return { ok: false, error: "GitHub port unavailable" };
	const note =
		lastGateNote && lastGateNote.trim().length > 0 ? lastGateNote.trim() : "_none recorded_";
	const body = [
		`## Rejection Limit Reached (${count})`,
		"",
		`The pipeline stopped after ${count} loop-back(s). Human intervention is required before it runs again.`,
		"",
		"**Last gate failure:**",
		"",
		note,
	].join("\n");
	try {
		await port.postIssueComment(issueNum, repo, body);
		return { ok: true };
	} catch (err: unknown) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Post or update the supervisor's audit rejection (issue #2044).
 *
 * The `reject-N` label is the durable loop counter for the in-place update
 * path, so it is written first and rolled back if the comment write fails.
 * When the label cannot be written the rejection is appended instead — the
 * legacy comment count then keeps the counter advancing, so a label outage
 * degrades to the old append behaviour instead of stalling the loop or
 * aborting the pipeline.
 *
 * Superseded rejection comments (older ones on an issue rejected before this
 * feature) are deleted only while the label counter is authoritative;
 * otherwise they are exactly what keeps the comment-count fallback growing.
 */
export async function postOrUpdateAuditRejection(
	issueNum: number,
	config: SupervisorConfig,
	body: string,
	loopFilteredData: FilteredIssueData | undefined,
	collector: ErrorCollector | undefined,
	port: GitHubPort | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!port) {
		collector?.push("stages", "error", "Cannot record audit rejection: GitHub port unavailable");
		return;
	}
	const rejections = loopFilteredData?.auditRejections ?? [];
	const prior = findPriorAuditRejection(rejections);

	// Resolve the counter before writing so a label outage can fall back to a
	// new comment (which grows the legacy count) instead of aborting.
	let labels: string[] | undefined;
	try {
		labels = await port.getIssueLabels(issueNum, config.repo);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("stages", "warn", `Failed to read reject labels: ${msg}`);
	}
	const current = countAuditRejections(labels ?? [], loopFilteredData?.rejectionCommentCount ?? 0);
	const next = current + 1;

	// Label first: an in-place update keeps a single rejection comment, so the
	// label is the only durable record of the increment.
	let bumped = false;
	if (labels) {
		try {
			await port.addIssueLabel(issueNum, config.repo, rejectLabel(next));
			bumped = true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			collector?.push("stages", "warn", `Failed to record reject label: ${msg}`);
		}
	}

	const updateInPlace = !!prior && bumped;
	try {
		if (updateInPlace && prior) {
			await port.updateIssueComment(prior.id, config.repo, body);
			ctx.ui.notify("Audit rejection comment updated in place", "info");
		} else {
			await port.postIssueComment(issueNum, config.repo, body);
			ctx.ui.notify("Audit rejection comment posted", "info");
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const action = updateInPlace ? "update" : "post";
		collector?.push("stages", "error", `Failed to ${action} audit rejection: ${msg}`);
		ctx.ui.notify(`Audit rejection could not be saved: ${msg}`, "error");
		// Roll back the counter bump — the rejection was not persisted, so the
		// loop must not advance — then fail closed: the next implementation run
		// would otherwise have no feedback.
		if (bumped) {
			try {
				await port.removeIssueLabel(issueNum, config.repo, rejectLabel(next));
			} catch (rollbackErr: unknown) {
				const rollbackMsg =
					rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
				collector?.push("stages", "warn", `Failed to roll back reject label: ${rollbackMsg}`);
			}
		}
		throw new Error(`Failed to ${action} audit rejection: ${msg}`);
	}

	if (!bumped) return;
	// The label now carries the count, so stale rejections can be removed.
	await deleteSupersededRejections(
		port,
		config.repo,
		rejections,
		updateInPlace ? prior?.id : undefined,
		collector,
	);
	if (current > 0) {
		try {
			await port.removeIssueLabel(issueNum, config.repo, rejectLabel(current));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			collector?.push("stages", "warn", `Failed to remove stale reject label: ${msg}`);
		}
	}
}

/**
 * Delete every supervisor rejection comment except `keepId` (issue #2044):
 * older issues accumulated one rejection comment per loop, and the in-place
 * update only collapses the newest. Best effort — a failed delete must not
 * block the audit transition.
 */
async function deleteSupersededRejections(
	port: GitHubPort,
	repo: string,
	rejections: Array<{ id?: string }>,
	keepId: string | undefined,
	collector: ErrorCollector | undefined,
): Promise<void> {
	for (const rejection of rejections) {
		if (rejection.id && rejection.id !== keepId) {
			try {
				await port.deleteIssueComment(rejection.id, repo);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				collector?.push(
					"stages",
					"warn",
					`Failed to delete superseded rejection ${rejection.id}: ${msg}`,
				);
			}
		}
	}
}

/**
 * Post an approval comment, retiring any supervisor rejection it supersedes:
 * an approved issue must not keep advertising a rejection the audit cleared
 * (issue #2044).
 */
export async function postApprovalComment(
	body: string,
	notifyMessage: string,
	issueNum: number,
	config: SupervisorConfig,
	collector: ErrorCollector | undefined,
	port: GitHubPort | undefined,
	loopFilteredData: FilteredIssueData | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!port) return;
	try {
		await port.postIssueComment(issueNum, config.repo, body);
		ctx.ui.notify(notifyMessage, "info");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("stages", "warn", `Failed to post audit approval comment: ${msg}`);
		return;
	}
	await deleteSupersededRejections(
		port,
		config.repo,
		loopFilteredData?.auditRejections ?? [],
		undefined,
		collector,
	);
}

// ─── CI loop-back (issue #1829) ───────────────────────────────────

/** Test seams — production callers omit these. */
export interface CiLoopBackOverrides {
	postRejection?: typeof postCiGateRejection;
	upsertPr?: typeof upsertDeveloperPr;
}

/** Payload the developer PR refresh needs after a loop-back. */
export interface CiLoopBackPrInput {
	pi: ExtensionAPI;
	issueTitle: string;
	worktreePath?: string;
	worktreeBranch?: string;
	gateFailureHistory: string[];
}

/** Everything one CI loop-back needs recorded. */
export interface CiLoopBackInput {
	issueNum: number;
	config: SupervisorConfig;
	/** The CI gate failure section (names the red checks). */
	note: string;
	iteration: number;
	ctx: ExtensionCommandContext;
	collector?: ErrorCollector;
	port?: GitHubPort;
	pr: CiLoopBackPrInput;
	overrides?: CiLoopBackOverrides;
}

/**
 * Record a CI-gate loop-back (AC1/AC2) and refresh the PR body so the red
 * checks are visible on both surfaces. A failed counter/comment write is
 * reported (`ok: false`) so the caller stops the pipeline — an uncounted
 * loop-back would let a red CI spin the developer forever. The PR refresh is
 * best effort: the issue comment already names the checks.
 */
export async function recordCiLoopBack(
	input: CiLoopBackInput,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
	const { issueNum, config, note, iteration, ctx, collector, port, pr, overrides } = input;
	let count: number;
	try {
		const postRejection = overrides?.postRejection ?? postCiGateRejection;
		count = await postRejection(issueNum, config, note, iteration, collector, port, ctx);
	} catch (err: unknown) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}

	try {
		const upsertPr = overrides?.upsertPr ?? upsertDeveloperPr;
		await upsertPr({
			pi: pr.pi,
			issueNum,
			issueTitle: pr.issueTitle,
			config,
			worktreePath: pr.worktreePath ?? ctx.cwd,
			worktreeBranch: pr.worktreeBranch,
			port,
			collector,
			gateFailureHistory: pr.gateFailureHistory,
		});
	} catch (err: unknown) {
		const msg = `Could not refresh the PR with the gate history: ${
			err instanceof Error ? err.message : String(err)
		}`;
		ctx.ui.notify(msg, "warning");
		collector?.push("stages", "warn", msg);
	}
	return { ok: true, count };
}

/** Outcome of the pre-loop-back history check. */
export type UncommitOutcome = "skipped-on-remote" | "uncommitted" | "unknown" | "no-commit";

/**
 * Uncommit the developer's most recent commit — only while it is unpushed.
 *
 * A gate failure must not produce fresh developer context (only auditor
 * rejections should): `reset --soft HEAD~1` keeps the changes staged. That is
 * safe just for a local-only HEAD; a pushed commit stays put and the developer
 * adds fix commits on top (AC3). An unanswerable probe preserves history, a
 * missing commit is a no-op.
 */
export async function uncommitDeveloperWork(
	exec: ExecFn,
	worktreePath: string,
	remote: string,
	branch: string,
	ui: ExtensionCommandContext["ui"],
	collector?: ErrorCollector,
): Promise<UncommitOutcome> {
	const head = await isHeadOnRemote(exec, worktreePath, remote, branch);

	if (head.status !== "not-on-remote") {
		const detail = head.error ? ` (${head.error})` : "";
		const why =
			head.status === "on-remote"
				? `HEAD is already on ${remote}/${branch} — uncommit skipped, the pushed commit is preserved. The developer adds fix commits on top.`
				: `cannot tell whether HEAD is pushed${detail} — uncommit skipped so pushed history is never rewritten.`;
		ui.notify(`Gate failure: ${why}`, "warning");
		if (head.status === "unknown") {
			collector?.push("audit", "warn", `Skipped uncommit, pushed state unknown${detail}`);
		}
		return head.status === "on-remote" ? "skipped-on-remote" : "unknown";
	}

	try {
		await exec("git", ["reset", "--soft", "HEAD~1"], { cwd: worktreePath, timeout: 10_000 });
		return "uncommitted";
	} catch (err: unknown) {
		// No commit to uncommit — the developer may have made no changes, else
		// detached HEAD / initial commit. The worktree is already as desired.
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("audit", "warn", `Uncommit failed: ${msg}`);
		return "no-commit";
	}
}
