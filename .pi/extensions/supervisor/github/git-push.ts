// ─── Git Operations: push ───────────────────────────────────────
// Push one branch, retrying with --force-with-lease on a non-fast-forward
// rejection (a retry is safe while the branch is pipeline-owned).

import type { ExecFn } from "../../lib/port-types.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { withNotify, type Result } from "../pipeline/result.ts";
import type { NotifyFn } from "../pipeline/helpers.ts";
import { detectTokenClass } from "./gh-client.ts";
import { workflowRejectionClause } from "./workflow-reject.ts";
import { workflowScopeHint } from "./workflow-scope.ts";

/** Push a branch to a remote. Retries with --force-with-lease on non-fast-forward rejection. */
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
			// Retry with --force-with-lease: safe while the branch is pipeline-owned
			// (single-author) and fails closed if a concurrent/resumed instance
			// advanced the remote since our last fetch (mid-pipeline rebases rewrite
			// SHAs, so every refresh makes the next stage push non-fast-forward).
			if (stderr.includes("non-fast-forward") || stderr.includes("fetch first")) {
				log.warn("git", "Non-fast-forward push — retrying with --force-with-lease", {
					cwd,
					remote,
					branch,
					stderr: stderr.slice(0, 300),
				});
				const forceResult = await exec("git", ["push", "--force-with-lease", remote, branch], {
					cwd,
				});
				if (forceResult.code === 0) {
					log.info("git", `git push --force-with-lease OK — ${remote}/${branch}`);
					return;
				}
				const forceStderr = (forceResult.stderr || "") + (forceResult.stdout || "");
				const forceClause = workflowRejectionClause(forceStderr);
				if (forceClause) {
					throw new Error(
						`git push failed: ${forceClause} — remediation: ${workflowScopeHint(detectTokenClass())}`,
					);
				}
				log.error("git", "git push --force-with-lease also failed", {
					cwd,
					stderr: forceStderr.slice(0, 500),
				});
				throw new Error(`git push --force-with-lease failed: ${forceStderr}`);
			}

			const clause = workflowRejectionClause(stderr);
			if (clause) {
				throw new Error(
					`git push failed: ${clause} — remediation: ${workflowScopeHint(detectTokenClass())}`,
				);
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
