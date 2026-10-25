// ─── Git Operations ──────────────────────────────────────────────
// `commitChanges` (single commit) plus explicit re-exports of the push and
// landing families — issue #2033 split: push in git-push.ts, commit+push in
// git-commit-and-push.ts, the workflow-scope gate in workflow-scope.ts and
// workflow-exempt.ts. Existing importers of git.ts are untouched.

import type { ExecFn } from "../../lib/port-types.ts";
import { getDebugLogger } from "../lib/debug.ts";

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

export { pushBranch } from "./git-push.ts";
export { commitAndPush } from "./git-commit-and-push.ts";
export { workflowScopeHint } from "./workflow-scope.ts";
export { workflowChangesExempt } from "./workflow-exempt.ts";
