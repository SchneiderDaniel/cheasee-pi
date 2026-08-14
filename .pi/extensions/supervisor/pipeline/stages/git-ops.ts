// ─── Pipeline Stages — git operations ────────────────────────────
// Pre-condition branch/range checks (hasBranchCommits, gitCherryContains)
// and the developer commit+push side effect (handleDeveloperCommit).
// All git access shells out to system git via execFn with argv-array
// discipline — args are separate argv elements, never shell-joined.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { NotifyFn } from "../helpers.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { commitAndPush } from "../../github/git.ts";

export async function hasBranchCommits(
	execFn: (
		cmd: string,
		args: string[],
		opts?: Record<string, unknown>,
	) => Promise<{ code: number; stdout: string; stderr: string }>,
	worktreePath: string,
	headBranch: string,
	baseBranch: string,
): Promise<boolean> {
	try {
		const result = await execFn("git", ["rev-list", "--count", `${baseBranch}..${headBranch}`], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		if (result.code !== 0) {
			// Command failed — fail-safe: allow pipeline to continue
			return true;
		}
		const count = parseInt(result.stdout?.trim() || "0", 10);
		return count > 0;
	} catch {
		// Exception — fail-safe: allow pipeline to continue
		return true;
	}
}

/**
 * Check whether commits in a range have already been applied upstream.
 * Uses `git cherry` to detect equivalent changes.
 *
 * `git cherry` output prefixes each commit with:
 *   - `-` (space + hyphen) — already applied upstream
 *   - `+` (space + plus) — not yet applied upstream
 *
 * All `-` prefixed → returns true (changes already upstream)
 * Any `+` prefixed → returns false (changes not yet upstream)
 * Empty output (no commits in range) → returns false (nothing to compare)
 *
 * Fail-safe: returns true (assumes changes present) if the git command
 * fails or throws, matching the pattern from hasBranchCommits.
 *
 * @param execFn - Function to execute shell commands
 * @param worktreePath - Path to the worktree
 * @param baseBranch - Base branch to compare against (e.g. "main")
 * @param range - Range to check (e.g. "HEAD~3..HEAD" or a branch name)
 * @returns true if all commits in range are already applied upstream
 */
export async function gitCherryContains(
	execFn: (
		cmd: string,
		args: string[],
		opts?: Record<string, unknown>,
	) => Promise<{ code: number; stdout: string; stderr: string }>,
	worktreePath: string,
	baseBranch: string,
	range: string,
): Promise<boolean> {
	try {
		const result = await execFn("git", ["cherry", baseBranch, range], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		if (result.code !== 0) {
			// Command failed — fail-safe: assume changes are present
			return true;
		}
		const stdout = result.stdout?.trim() || "";
		if (!stdout) {
			// Empty output — no commits in range, nothing to compare
			return false;
		}
		// Each line starts with "- " (applied) or "+ " (not applied)
		const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
		for (const line of lines) {
			if (line.startsWith("+ ")) {
				// Found a commit not yet applied upstream
				return false;
			}
		}
		// All entries are "- " prefixed — changes already upstream
		return true;
	} catch {
		// Exception — fail-safe: assume changes are present
		return true;
	}
}

// ─── Resolved-By Info Fetcher ────────────────────────────────────
// Fetches the resolving commit SHA and PR number for the default branch.
// Called when case 2 (close with named resolution) is triggered.
// Uses git log for the latest commit SHA and the port to find merged PRs.
// Fail-soft: returns placeholder values if git/API calls fail.
// Symbol home moved here from handler/shared.ts (issue #1533); shared.ts
// re-exports it so consumers resolve the unchanged import path.

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

// ─── Developer commit + push ─────────────────────────────────────

/**
 * Commit and push the developer's worktree changes.
 * Returns false ONLY on commitAndPush failure (pipeline stops);
 * a failed comment post in the agent-comment phase still returns true.
 */
export async function handleDeveloperCommit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: SupervisorConfig,
	worktreePath: string,
	worktreeBranch: string,
	issueNum: number,
	issueTitle: string,
	collector?: ErrorCollector,
	notify?: NotifyFn,
): Promise<boolean> {
	const commitMsg = `feat(#${issueNum}): ${issueTitle}`;
	// Use provided notify or create a null-safe fallback
	const pushNotify: NotifyFn = notify || {
		info: (msg) => ctx.ui.notify(msg, "info"),
		error: (msg) => ctx.ui.notify(msg, "error"),
	};
	const commitResult = await commitAndPush(
		pi.exec.bind(pi),
		worktreePath,
		config.remote!,
		worktreeBranch,
		commitMsg,
		pushNotify,
	);
	if (!commitResult.ok) {
		ctx.ui.notify(`commitAndPush failed: ${commitResult.error}`, "warning");
		collector?.push("stages", "error", `commitAndPush failed: ${commitResult.error}`);
		return false;
	}
	if (commitResult.value) {
		ctx.ui.notify("Changes committed and pushed to branch", "info");
	} else {
		ctx.ui.notify("No changes to commit — pipeline continues", "info");
	}
	return true;
}
