// ─── Conditional task blocks ────────────────────────────────────
// The optional sections an agent task can carry: research findings, a blocked
// gate, an audit rejection, a rebase conflict, a resumed run. Each returns ""
// when it does not apply, so the task template reads as concatenation.
// Split out of task.ts (issue #2033).

export interface ConditionalBlocks {
	remote: string;
	defaultBranch: string;
	researchFindings?: string | null;
	gateFailureContext?: string;
	auditFeedback?: string | null;
	rebaseConflictContext?: string | null;
	wipResumeContext?: { sha: string; subject: string } | null;
}

/** The research-findings block (injected for the architect from issue comments). */
export function researchBlock(researchFindings?: string | null): string {
	return researchFindings ? `\n### Research Findings\n\n${researchFindings}\n` : "";
}

/**
 * The gate-failure block (injected for the developer when a pre-transition hook —
 * CI, TSC checkpoint, LSP pre-audit — blocked Implementation to Audit). Wrapped in
 * XML tags for higher salience per Anthropic context-engineering guidance.
 */
export function gateFailureBlock(
	gateFailureContext: string | undefined,
	remote: string,
	defaultBranch: string,
): string {
	return gateFailureContext
		? `<previous_gate_failure>
⚠️ THE PREVIOUS IMPLEMENTATION ATTEMPT WAS BLOCKED BY AUTOMATED CHECKS.
The following automated checks failed and blocked the transition to Audit.
You MUST address every item below before completing the implementation.
${gateFailureContext}
Action items:
1. Run \`git status\` — check for partial changes from the previous attempt
2. Run \`git log --oneline ${remote}/${defaultBranch}..HEAD\` — check for unpushed commits
3. Fix every issue listed above
4. Do NOT redo work that passed these checks — only fix what failed
</previous_gate_failure>
`
		: "";
}

/**
 * The audit-feedback block (injected for the developer when looping back from an
 * Audit rejection). Prominent on purpose: it appears BEFORE the generic task
 * instructions so the developer cannot miss it.
 */
export function auditFeedbackBlock(auditFeedback?: string | null): string {
	return auditFeedback
		? `🔴 **AUDITOR REJECTED YOUR PREVIOUS IMPLEMENTATION — FIX THESE ISSUES**

The previous audit found problems with your implementation. You MUST fix every issue listed below
before marking the task complete. Do NOT ignore or defer any critical or warning finding.

${auditFeedback}\n`
		: "";
}

/**
 * The rebase-conflict block (issue #1473): the aborted rebase discards conflict
 * markers, so the developer gets explicit merge-reintegration steps. git push
 * stays pipeline-owned.
 */
export function rebaseConflictBlock(
	rebaseConflictContext: string | null | undefined,
	defaultBranch: string,
	remote: string,
): string {
	return rebaseConflictContext
		? (() => {
				const files = rebaseConflictContext
					.split("\n")
					.map((p) => p.trim())
					.filter((p) => p.length > 0);
				return `\n\n### Reintegrate main\n\n⚠️ YOUR BRANCH CONFLICTS WITH THE LATEST \`${defaultBranch}\`. The pipeline attempted to rebase your worktree onto \`${remote}/${defaultBranch}\` before this implementation run, but ${files.length} file(s) conflicted:\n\n${files.map((p) => `- \`${p}\``).join("\n")}\n\nResolve these conflicts BEFORE implementing the issue:\n1. Fetch base: \`git fetch ${remote} ${defaultBranch}\`\n2. Merge base: \`git merge ${remote}/${defaultBranch}\`\n3. Resolve conflicts in the files listed above — keep your work, integrate main's changes\n4. Stage resolved files: \`git add -A\`\n5. Commit merge: \`git commit -m "fix: resolve conflicts with ${defaultBranch}"\`\n\nDo NOT run \`git push\` — the pipeline owns pushing.\n`;
			})()
		: "";
}

/**
 * The resume block (issue #1987): a prior run hit its deadline and preserved its
 * partial work as a marked wip commit, so the developer must continue, not restart.
 */
export function wipResumeBlock(
	wipResumeContext: { sha: string; subject: string } | null | undefined,
): string {
	return wipResumeContext
		? `\n\n### Resume previous work (continue, do not restart)\n\n⚠️ A PRIOR RUN WAS KILLED BY THE DEADLINE. Its partial work is already committed on this branch as \`${wipResumeContext.sha.slice(0, 12)}\` — ${wipResumeContext.subject}.\n\n1. Run \`git show --stat ${wipResumeContext.sha}\` — see what the previous run already changed\n2. Read those files and CONTINUE, do not restart — complete the remaining work without discarding working changes\n3. Do NOT run \`git push\` — the pipeline owns pushing\n`
		: "";
}
