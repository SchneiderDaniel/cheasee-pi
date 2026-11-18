// ─── Git exec port (shared) ──────────────────────────────────────
// The one place a git command is spawned. Extracted from
// supervisor/pipeline/worktree.ts (issue #2138) so the Supervisor and the
// goal-loop extension issue identical argv through identical error mapping.

import type { ExecOptions } from "@earendil-works/pi-coding-agent";
import { failure, type Result } from "../result.ts";

/**
 * The exec result this module needs. Structurally narrower than Pi's
 * `ExecResult` so any exec port (Pi's `pi.exec`, the test harness's `ExecFn`)
 * is accepted without a cast.
 */
export interface ExecOutcome {
	code: number;
	stdout: string;
	stderr: string;
}

/** The injected exec port: `pi.exec.bind(pi)` in production. */
export type ExecLike = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecOutcome>;

/** Default git command timeout for worktree operations (ms). */
export const GIT_TIMEOUT_MS = 15_000;

/** Run one git command, normalizing a rejecting exec into a failed Result. */
export async function runGit(
	exec: ExecLike,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<Result<ExecOutcome>> {
	try {
		const res = await exec("git", args, { cwd, timeout: timeoutMs });
		if (res.code !== 0) {
			return failure(res.stderr || res.stdout || `git ${args[0]} failed`, "git");
		}
		return { ok: true, value: res };
	} catch (err: unknown) {
		return failure(err instanceof Error ? err.message : String(err), "git");
	}
}
