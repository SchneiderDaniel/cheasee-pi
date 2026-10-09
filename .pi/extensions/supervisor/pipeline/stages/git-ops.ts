// ─── Pipeline Stages — git operations ────────────────────────────
// Pre-condition branch/range checks (hasBranchCommits)
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

// ─── Timed-out work preservation (issue #1987) ───────────────────

/** Outcome of a timed-out-work preservation attempt. */
export interface PreservedWork {
	committed: boolean;
	sha?: string;
	files: string[];
	error?: string;
}

/** A preserved partial-work commit found on the branch. */
export interface WipCommit {
	sha: string;
	subject: string;
}

/**
 * Parse `git log --format=%H %s` output for a preserved `wip(#N)` commit.
 * The sha of the first matching subject is returned; otherwise null.
 */
export function parseWipCommit(gitLog: string, issueNum: number): WipCommit | null {
	const marker = new RegExp(`^wip\\(#${issueNum}\\)`, "i");
	for (const line of gitLog.split("\n")) {
		const match = line.trim().match(/^([0-9a-f]{7,40})\s+(.+)$/i);
		if (match?.[2] && marker.test(match[2].trim())) {
			return { sha: match[1]!, subject: match[2].trim() };
		}
	}
	return null;
}

/**
 * Detect a preserved `wip(#N)` commit from a prior timed-out developer run on
 * the current branch. Fail-soft: any git failure or absent marker → null, so a
 * transient git error never fabricates a resume block.
 */
export async function detectPreservedWork(
	pi: ExtensionAPI,
	worktreePath: string,
	issueNum: number,
): Promise<WipCommit | null> {
	try {
		const result = await pi.exec("git", ["log", "--format=%H %s", "-n", "20"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		if (result.code !== 0) return null;
		return parseWipCommit(result.stdout || "", issueNum);
	} catch {
		return null;
	}
}

/**
 * Preserve a timed-out agent's uncommitted work as a marked `wip(#N)` commit
 * pushed to the branch, so the next run resumes instead of restarting. The
 * push is required: worktree recreation runs `git reset --hard <remote>/<branch>`
 * and would discard a local-only commit. Fail-soft — never throws, so a git
 * failure cannot suppress the timeout stop that the caller still reports.
 */
export async function preserveTimedOutWork(
	pi: ExtensionAPI,
	worktreePath: string,
	remote: string,
	branch: string,
	issueNum: number,
	notify?: NotifyFn,
): Promise<PreservedWork> {
	const pushNotify: NotifyFn = notify || { info: () => {}, error: () => {} };
	try {
		const status = await pi.exec("git", ["status", "--porcelain"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		if (status.code !== 0) {
			return {
				committed: false,
				files: [],
				error: `git status failed: ${status.stderr || status.stdout || ""}`,
			};
		}
		const files = (status.stdout || "")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => line.replace(/^\S+\s+/, ""));
		if (files.length === 0) return { committed: false, files: [] };

		const message = `wip(#${issueNum}): partial work preserved on timeout`;
		const commitResult = await commitAndPush(
			pi.exec.bind(pi),
			worktreePath,
			remote,
			branch,
			message,
			pushNotify,
		);
		if (!commitResult.ok) return { committed: false, files, error: commitResult.error };

		const head = await pi.exec("git", ["rev-parse", "HEAD"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		const sha = head.code === 0 ? (head.stdout || "").trim() : undefined;
		return { committed: true, files, sha };
	} catch (err: unknown) {
		return {
			committed: false,
			files: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
