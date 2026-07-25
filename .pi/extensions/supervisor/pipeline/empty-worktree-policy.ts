// ─── Empty Worktree Policy ──────────────────────────────────────
// Classifies the empty-worktree situation into one of three actions:
//   - loop:   No commits, changes absent on main → bounce back to Implementation
//   - close:  No commits, changes already on main → close with named resolution
//   - leaveOpenForPr: No commits, open PR exists → leave open for PR review
//
// Pure function — no I/O. Receives pre-fetched EmptyWorktreeSignals from the
// handler and returns the action to take.

// ─── Types ───────────────────────────────────────────────────────

/** A reference to a pull request that targets or resolves this issue. */
export interface ClosingPrRef {
	number: number;
	/** Commit SHA (merge commit for merged PRs, head SHA for open PRs). */
	sha: string;
	/** How this PR was found: via closing keyword on the issue, or by matching branch head. */
	source: "closing-keyword" | "branch-head";
	/** Branch name of the PR head (for open PRs). */
	branch: string;
}

/** Signals pre-fetched by the handler for the classifier. */
export interface EmptyWorktreeSignals {
	/** Whether the worktree branch has commits ahead of the default branch. */
	hasCommits: boolean;
	/** Whether the issue's required changes are already present on the default branch. */
	changeOnMain: boolean;
	/** Open PRs referencing or targeting this issue. */
	openPrs: ClosingPrRef[];
}

/** Discriminated union of possible actions for an empty worktree. */
export type EmptyWorktreeAction =
	| { kind: "loop"; reason: string }
	| {
			kind: "close";
			resolvedBy: { sha: string; prNumber: number; source: string };
	  }
	| { kind: "leaveOpenForPr"; prNumber: number; branch: string };

// ─── Classifier ─────────────────────────────────────────────────

/**
 * Classify an empty worktree situation based on pre-fetched signals.
 *
 * Rules:
 * - If hasCommits is true → return null (not an empty-worktree situation)
 * - If open PRs exist → leaveOpenForPr (PR takes precedence over close)
 * - If changeOnMain is true → close with resolving commit/PR info
 * - If changeOnMain is false and no open PRs → loop back to Implementation
 *
 * @param signals - Pre-fetched signals from the handler
 * @returns EmptyWorktreeAction or null if classifier doesn't apply (hasCommits is true)
 */
export function classifyEmptyWorktree(
	signals: EmptyWorktreeSignals,
): EmptyWorktreeAction | null {
	const { hasCommits, changeOnMain, openPrs } = signals;

	// Not an empty-worktree situation — caller should not have invoked classifier
	if (hasCommits) {
		return null;
	}

	// Case 3: Open PR exists — leave open for PR review to drive state
	if (openPrs.length > 0) {
		const pr = openPrs[0]!;
		return {
			kind: "leaveOpenForPr",
			prNumber: pr.number,
			branch: pr.branch,
		};
	}

	// Case 2: Changes already on main — close with named resolution
	if (changeOnMain) {
		return {
			kind: "close",
			resolvedBy: {
				// When no specific commit is identified, use a descriptive source
				sha: "main",
				prNumber: 0,
				source: "main-branch",
			},
		};
	}

	// Case 1: No commits, changes absent on main — loop back to Implementation
	return {
		kind: "loop",
		reason: "No commits on worktree branch and required changes not present on main — looping back to Implementation.",
	};
}

// ─── Comment Builder ─────────────────────────────────────────────

/**
 * Build a close comment body that names the resolving commit/PR.
 *
 * @returns A markdown string for the GitHub issue comment.
 */
export function buildResolvedByComment(resolvedBy: {
	sha: string;
	prNumber: number;
	source: string;
}): string {
	const lines: string[] = [
		"## Issue Already Resolved",
		"",
	];

	if (resolvedBy.prNumber > 0) {
		lines.push(
			`Required changes were already present on \`main\` via commit \`${resolvedBy.sha}\` (PR #${resolvedBy.prNumber}). Closing.`,
		);
	} else if (resolvedBy.source === "main-branch") {
		lines.push(
			"Required changes are already present on \`main\`. Closing.",
		);
	} else {
		lines.push(
			`Required changes were already present on \`main\`. Closing (source: ${resolvedBy.source}).`,
		);
	}

	lines.push(
		"",
		"*This issue was automatically closed by the supervisor pipeline — the developer worktree had no unique commits because the necessary changes were already on \`main\`.*",
	);

	return lines.join("\n");
}

/**
 * Build a "leave open for PR" comment body.
 *
 * @returns A markdown string for the GitHub issue comment.
 */
export function buildLeaveOpenForPrComment(prNumber: number, branch: string): string {
	return [
		"## Open PR Targets This Issue",
		"",
		`Open PR #${prNumber} (branch \`${branch}\`) targets this issue — leaving open for PR review to drive state.`,
		"",
		"*The supervisor pipeline produced no unique commits in the worktree branch because this PR already addresses the issue. No auditor dispatch needed.*",
	].join("\n");
}
