// ─── Git Operations ──────────────────────────────────────────────
// commitChanges, pushBranch, commitAndPush.
// pushBranch and commitAndPush return Result<T> for explicit failure handling.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDebugLogger } from "../config/debug.ts";
import { withNotify, type Result } from "../pipeline/result.ts";
import type { NotifyFn } from "../pipeline/helpers.ts";

/** Commit staged changes in a working directory. */
export async function commitChanges(pi: ExtensionAPI, cwd: string, message: string): Promise<void> {
	const log = getDebugLogger();
	log.info("git", `git commit -m "${message.slice(0, 100)}"`, { cwd });
	const result = await pi.exec("git", ["commit", "-m", message], { cwd });
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
	pi: ExtensionAPI,
	cwd: string,
	remote: string,
	branch: string,
	notify: NotifyFn,
): Promise<Result<void>> {
	return withNotify(
		async () => {
			const log = getDebugLogger();
			log.info("git", `git push ${remote} ${branch}`, { cwd });
			const result = await pi.exec("git", ["push", remote, branch], { cwd });
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
				const forceResult = await pi.exec("git", ["push", "--force", remote, branch], {
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
 * When scopePaths is provided and non-empty, stages only those paths
 * instead of all changes (git add -A). Protects files outside issue scope.
 * @param scopePaths - Optional list of paths to stage. Empty/undefined = git add -A (backward compat).
 * @returns Promise<Result<boolean>> — true if commits were pushed, false if nothing to commit.
 */
export async function commitAndPush(
	pi: ExtensionAPI,
	cwd: string,
	remote: string,
	branch: string,
	message: string,
	notify: NotifyFn,
	scopePaths?: string[],
): Promise<Result<boolean>> {
	const log = getDebugLogger();
	log.info("git", `commitAndPush starting: ${branch}`, {
		cwd,
		remote,
		message: message.slice(0, 100),
		scopePaths: scopePaths?.length ? scopePaths : undefined,
	});

	try {
		// When scopePaths is set and non-empty, use scoped git add
		// instead of git add -A to protect files outside issue scope.
		if (scopePaths && scopePaths.length > 0) {
			const addArgs = ["add", "--", ...scopePaths];
			const addResult = await pi.exec("git", addArgs, { cwd });
			if (addResult.code !== 0) {
				log.error("git", "git add -- <paths> failed", {
					cwd,
					paths: scopePaths,
					stderr: (addResult.stderr || "").slice(0, 500),
				});
				throw new Error(`git add failed: ${addResult.stderr || addResult.stdout}`);
			}
			log.debug("git", "git add -- <paths> OK", { paths: scopePaths });
		} else {
			const addResult = await pi.exec("git", ["add", "-A"], { cwd });
			if (addResult.code !== 0) {
				log.error("git", "git add -A failed", {
					cwd,
					stderr: (addResult.stderr || "").slice(0, 500),
				});
				throw new Error(`git add failed: ${addResult.stderr || addResult.stdout}`);
			}
			log.debug("git", "git add -A OK");
		}

		const commitResult = await pi.exec("git", ["commit", "-m", message], { cwd });
		if (commitResult.code !== 0) {
			const output = (commitResult.stderr || "") + (commitResult.stdout || "");
			if (output.includes("nothing to commit")) {
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

		// pushBranch already uses withNotify — it handles notification on failure.
		// If push fails, propagate its Result without double-notifying.
		const pushResult = await pushBranch(pi, cwd, remote, branch, notify);
		if (!pushResult.ok) {
			return { ok: false, error: pushResult.error, source: "git" };
		}

		log.info("git", `commitAndPush complete: ${branch}`);
		return { ok: true, value: true };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		notify.error(`[git] ${msg}`);
		return { ok: false, error: msg, source: "git" };
	}
}
