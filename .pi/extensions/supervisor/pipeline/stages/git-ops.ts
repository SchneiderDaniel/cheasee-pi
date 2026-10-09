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
import type { ExecFn } from "../../../lib/port-types.ts";
import { commitAndPush, pushBranch } from "../../github/git.ts";

/**
 * Per-git-command bound for timeout preservation. `pushBranch` shells out to
 * `git push` with no timeout, so a stalled push would hang the timeout path
 * until SIGTERM — before the caller can flag the worktree for retention. Explicit
 * per-call timeouts stay authoritative; unit-bounded calls inherit this bound.
 */
export const PRESERVATION_GIT_TIMEOUT_MS = 30_000;

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
 * Resolve the ref to compare HEAD against when preserving local-only commits.
 * Prefers `<remote>/<branch>`; when that tracking ref is absent (fresh branch
 * never pushed) falls back to `<remote>/<baseBranch>` then `<baseBranch>`. An
 * unresolvable ref set is fail-soft (ok:false) so the caller reports the error
 * rather than pushing a spurious marker commit.
 */
async function resolvePreservationBase(
	exec: ExecFn,
	worktreePath: string,
	remote: string,
	branch: string,
	baseBranch: string,
): Promise<{ ok: true; ref: string; count: number } | { ok: false; error: string }> {
	const candidates = [`${remote}/${branch}`, `${remote}/${baseBranch}`, baseBranch];
	let lastError = "";
	for (const ref of candidates) {
		const ahead = await exec("git", ["rev-list", "--count", `${ref}..HEAD`], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		if (ahead.code === 0) {
			return { ok: true, ref, count: parseInt(ahead.stdout?.trim() || "0", 10) || 0 };
		}
		lastError = ahead.stderr || ahead.stdout || "";
	}
	return { ok: false, error: `git rev-list failed: ${lastError}` };
}

/**
 * Preserve a timed-out agent's work as a marked `wip(#N)` commit pushed to the
 * branch, so the next run resumes instead of restarting. Covers both a dirty
 * worktree (uncommitted edits) and a clean worktree with local commits the
 * developer made but did not push before the deadline. The push is required:
 * worktree recreation runs `git reset --hard <remote>/<branch>` and would
 * discard a local-only commit. Fail-soft — never throws, so a git failure
 * cannot suppress the timeout stop that the caller still reports.
 */
export async function preserveTimedOutWork(
	pi: ExtensionAPI,
	worktreePath: string,
	remote: string,
	branch: string,
	issueNum: number,
	notify?: NotifyFn,
	baseBranch = "main",
): Promise<PreservedWork> {
	const pushNotify: NotifyFn = notify || { info: () => {}, error: () => {} };
	// Bound every preservation git call (see PRESERVATION_GIT_TIMEOUT_MS). Explicit
	// per-call timeouts win; untimed calls (notably the inner `git push`) inherit
	// the bound so a stalled remote cannot hang the timeout path indefinitely.
	const exec: ExecFn = (cmd, args, opts) =>
		pi.exec(cmd, args, { timeout: PRESERVATION_GIT_TIMEOUT_MS, ...opts });
	try {
		const status = await exec("git", ["status", "--porcelain"], {
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
		if (files.length === 0) {
			// Clean worktree — but the developer may have committed locally and
			// timed out before pushing. Worktree recreation resets to
			// `<remote>/<branch>`, so any ahead commits must be pushed too, or the
			// recovery the WIP path exists for is lost.
			//
			// A fresh feature branch was never pushed, so its tracking ref is absent
			// and `rev-list <remote>/<branch>..HEAD` fails. Fall back to a known base
			// ref: otherwise preservation reports failure and post-pipeline cleanup
			// (worktree removal + branch delete) discards the only copy of the work.
			const ahead = await resolvePreservationBase(
				exec,
				worktreePath,
				remote,
				branch,
				baseBranch,
			);
			if (!ahead.ok) {
				return { committed: false, files: [], error: ahead.error };
			}
			if (ahead.count === 0) {
				return { committed: false, files: [] };
			}
			const changed = await exec(
				"git",
				["diff", "--name-only", `${ahead.ref}..HEAD`],
				{ cwd: worktreePath, timeout: 10_000 },
			);
			const changedFiles =
				changed.code <= 1 // 1 = differences (same --exit-code semantics as commitAndPush)
					? (changed.stdout || "")
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0)
					: [];
			// Mark HEAD so detectPreservedWork/parseWipCommit sees the preserved
			// work on the next run; an empty marker commit keeps the real commits
			// intact and makes the ahead work detectable for resume.
			const markResult = await exec(
				"git",
				["commit", "--allow-empty", "-m", `wip(#${issueNum}): partial work preserved on timeout`],
				{ cwd: worktreePath, timeout: 10_000 },
			);
			if (markResult.code !== 0) {
				return {
					committed: false,
					files: changedFiles,
					error: `git commit failed: ${markResult.stderr || markResult.stdout || ""}`,
				};
			}
			const pushResult = await pushBranch(
				exec,
				worktreePath,
				remote,
				branch,
				pushNotify,
			);
			if (!pushResult.ok) {
				return { committed: false, files: changedFiles, error: pushResult.error };
			}
			const aheadHead = await exec("git", ["rev-parse", "HEAD"], {
				cwd: worktreePath,
				timeout: 10_000,
			});
			return {
				committed: true,
				files: changedFiles,
				sha: aheadHead.code === 0 ? (aheadHead.stdout || "").trim() || undefined : undefined,
			};
		}

		const message = `wip(#${issueNum}): partial work preserved on timeout`;
		const commitResult = await commitAndPush(
			exec,
			worktreePath,
			remote,
			branch,
			message,
			pushNotify,
		);
		if (!commitResult.ok) return { committed: false, files, error: commitResult.error };

		const head = await exec("git", ["rev-parse", "HEAD"], {
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
