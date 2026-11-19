// ─── Rendered goal text: prompts, PR body, status ────────────────
// Pure renderers. `buildGenerationPrompt` is the ONLY thing a fresh session
// receives, so it is derived from the record alone — no transcript, message
// history or summary is passed (R5.AC3).

import type { GoalRecord, VerificationResult } from "../domain/goal-record.ts";

/** The branch a goal's worktree carries. */
export function goalBranchName(record: GoalRecord): string {
	return `goal/${record.id}`;
}

/** One criterion line: text plus its verification method. */
function criterionLine(criterion: GoalRecord["criteria"][number]): string {
	const verifier =
		criterion.verifier.kind === "command"
			? `command: ${criterion.verifier.argv.join(" ")} (expect exit ${criterion.verifier.expectExit})`
			: `inspect: ${criterion.verifier.instruction}`;
	return `- ${criterion.id}: ${criterion.text} [${verifier}]`;
}

/**
 * The fresh-session prompt for one generation. Derived from the record ONLY —
 * no prior transcript, message history or summary is passed (R5.AC3).
 */
export function buildGenerationPrompt(record: GoalRecord): string {
	const criteria =
		record.criteria.length === 0 ? "(none yet)" : record.criteria.map(criterionLine).join("\n");
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
		for (const v of record.verification)
			lines.push(`- ${v.criterionId}: ${v.result} — ${v.evidenceRef}`);
	}
	return lines.join("\n");
}

/** One criterion's verification line for `/goal status` (R4.AC3). */
function statusCriterion(
	criterion: GoalRecord["criteria"][number],
	verification: VerificationResult[],
): string {
	const result = verification.find((v) => v.criterionId === criterion.id);
	return `  - ${criterion.id}: ${result ? result.result : "unchecked"} — ${criterion.text}`;
}

/** `/goal status`: the loop's full visible state (R4.AC3). */
export function renderStatus(record: GoalRecord | null): string {
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
			lines.push(statusCriterion(criterion, record.verification));
		}
	}
	return lines.join("\n");
}

/** The clarification prompt `/goal <text>` sends to the agent (R1.AC2). */
export function buildClarificationPrompt(request: string): string {
	return (
		`Clarify this goal before any code changes:\n\n${request}\n\n` +
		"Restate it as a measurable goal and propose acceptance criteria that are each " +
		"verifiable by a command or by inspecting harness-produced evidence. Ask at most five " +
		"focused questions. Then call goal_submit_clarification."
	);
}
