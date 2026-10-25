// ─── Git Operations: commit and push ────────────────────────────
// The pipeline's landing sequence: stage everything, run the workflow-scope
// pre-push gate on the staged diff, commit, then push.

import type { ExecFn } from "../../lib/port-types.ts";
import { getDebugLogger } from "../lib/debug.ts";
import type { Result } from "../pipeline/result.ts";
import type { NotifyFn } from "../pipeline/helpers.ts";
import { pushBranch } from "./git-push.ts";
import { assertWorkflowScopeForPush } from "./workflow-scope.ts";

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
		// `git diff --cached --name-only --exit-code` doubles as the pre-push
		// workflow gate scan (exit 0 = nothing staged, 1 = differences, >1 =
		// error — same semantics as the old --quiet, but stdout also names the
		// files for the gate; --exit-code is required, plain --name-only exits 0
		// regardless of differences).
		let didCommit = false;
		const diffResult = await exec("git", ["diff", "--cached", "--name-only", "--exit-code"], {
			cwd,
		});
		const stagedFiles = (diffResult.stdout || "")
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (diffResult.code === 0) {
			log.info("git", "Nothing staged — skipping commit, proceeding to push");
		} else if (diffResult.code > 1) {
			throw new Error(`git diff --cached failed: ${diffResult.stderr || diffResult.stdout}`);
		} else {
			// code === 1 — differences staged. Fail fast on workflow-file pushes
			// with a token provably lacking the workflow scope (saves the pack
			// round-trip); introspection failure falls through to the real push.
			const gateError = await assertWorkflowScopeForPush(exec, cwd, remote, stagedFiles);
			if (gateError) {
				throw new Error(gateError);
			}
			// proceed with commit
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
