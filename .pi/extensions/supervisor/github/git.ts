// ─── Git Operations ──────────────────────────────────────────────
// commitChanges, pushBranch, commitAndPush.
// pushBranch and commitAndPush return Result<T> for explicit failure handling.

import type { ExecFn } from "../pipeline/helpers.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { withNotify, type Result } from "../pipeline/result.ts";
import type { NotifyFn } from "../pipeline/helpers.ts";

/** Commit staged changes in a working directory. */
export async function commitChanges(exec: ExecFn, cwd: string, message: string): Promise<void> {
	const log = getDebugLogger();
	log.info("git", `git commit -m "${message.slice(0, 100)}"`, { cwd });
	const result = await exec("git", ["commit", "-m", message], { cwd });
	if (result.code !== 0) {
		log.warn("git", "git commit failed", {
			cwd,
			stderr: (result.stderr || "").slice(0, 500),
			stdout: (result.stdout || "").slice(0, 500),
		});
		throw new Error(`git commit failed: ${result.stderr || result.stdout}`);
	}
	log.info("git", "git commit OK", {
		stdout: (result.stdout || "").slice(0, 200),
	});
}

/** Push a branch to a remote. Retries with --force on non-fast-forward rejection. */
export async function pushBranch(
	exec: ExecFn,
	cwd: string,
	remote: string,
	branch: string,
	notify: NotifyFn,
): Promise<Result<void>> {
	return withNotify(
		async () => {
			const log = getDebugLogger();
			log.info("git", `git push ${remote} ${branch}`, { cwd });
			const result = await exec("git", ["push", remote, branch], { cwd });
			if (result.code === 0) {
				log.info("git", `git push OK — ${remote}/${branch}`);
				return;
			}

			const stderr = (result.stderr || "") + (result.stdout || "");
			// Non-fast-forward: old branch exists remotely from previous pipeline run.
			// Force-push since this branch is pipeline-owned (single-author, not shared).
			if (stderr.includes("non-fast-forward") || stderr.includes("fetch first")) {
				log.warn("git", "Non-fast-forward push — retrying with --force", {
					cwd,
					remote,
					branch,
					stderr: stderr.slice(0, 300),
				});
				const forceResult = await exec("git", ["push", "--force", remote, branch], {
					cwd,
				});
				if (forceResult.code === 0) {
					log.info("git", `git push --force OK — ${remote}/${branch}`);
					return;
				}
				const forceStderr = (forceResult.stderr || "") + (forceResult.stdout || "");
				log.error("git", "git push --force also failed", {
					cwd,
					stderr: forceStderr.slice(0, 500),
				});
				throw new Error(`git push --force failed: ${forceStderr}`);
			}

			log.warn("git", "git push failed", {
				cwd,
				remote,
				branch,
				stderr: stderr.slice(0, 500),
			});
			throw new Error(`git push failed: ${stderr}`);
		},
		notify,
		"git",
	);
}

/**
 * Add, commit, and push in sequence.
 * @returns Promise<Result<boolean>> — true if commits were pushed, false if nothing to commit.
 */
export async function commitAndPush(
	exec: ExecFn,
	cwd: string,
	remote: string,
	branch: string,
	message: string,
	notify: NotifyFn,
): Promise<Result<boolean>> {
	const log = getDebugLogger();
	log.info("git", `commitAndPush starting: ${branch}`, {
		cwd,
		remote,
		message: message.slice(0, 100),
	});

	try {
		const addResult = await exec("git", ["add", "-A"], { cwd });
		if (addResult.code !== 0) {
			log.error("git", "git add -A failed", {
				cwd,
				stderr: (addResult.stderr || "").slice(0, 500),
			});
			throw new Error(`git add failed: ${addResult.stderr || addResult.stdout}`);
		}
		log.debug("git", "git add -A OK");

		// Pre-commit emptiness check: verify whether any changes are actually staged.
		let didCommit = false;
		const diffResult = await exec("git", ["diff", "--cached", "--quiet"], { cwd });
		if (diffResult.code === 0) {
			log.info("git", "Nothing staged — skipping commit, proceeding to push");
		} else if (diffResult.code > 1) {
			throw new Error(`git diff --cached failed: ${diffResult.stderr || diffResult.stdout}`);
		} else {
			// code === 1 — differences staged, proceed with commit
			didCommit = true;
			const commitResult = await exec("git", ["commit", "-m", message], { cwd });
			if (commitResult.code !== 0) {
				const output = (commitResult.stderr || "") + (commitResult.stdout || "");
				if (output.includes("nothing to commit") || output.includes("no changes added to commit")) {
					log.info("git", "Nothing to commit — still pushing (branch may not exist on remote)");
				} else {
					log.warn("git", "git commit failed", {
						cwd,
						output: output.slice(0, 500),
					});
					throw new Error(`git commit failed: ${output.trim()}`);
				}
			} else {
				log.info("git", "git commit OK");
			}
		}

		// pushBranch already uses withNotify — it handles notification on failure.
		// If push fails, propagate its Result without double-notifying.
		const pushResult = await pushBranch(exec, cwd, remote, branch, notify);
		if (!pushResult.ok) {
			return { ok: false, error: pushResult.error, source: "git" };
		}

		log.info("git", `commitAndPush complete: ${branch}`);
		return { ok: true, value: didCommit };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		notify.error(`[git] ${msg}`);
		return { ok: false, error: msg, source: "git" };
	}
}
