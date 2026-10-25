// ─── Workflow-scope exemption (identical-file rule) ──────────────
// GitHub's `workflow`-scope exemption: pushing workflow files that already
// exist byte-identically (same path AND content) on another branch of the repo
// needs no scope. Judged against the SERVER's branch picture, so local
// enumeration alone is never authoritative — a branch created or advanced
// since the last fetch is invisible locally and must not cause a false abort.

import type { ExecFn } from "../../lib/port-types.ts";

/**
 * Is every staged workflow file identical to some branch on the server?
 *
 *   1. `git ls-remote --heads <remote>` lists the server's branch tips (a ref
 *      advertisement — no pack transfer, unlike a fetch).
 *   2. Coverage is authoritative only if every server head has a matching
 *      local remote-tracking ref with the same sha (that fetch also brought
 *      the trees/blobs, so `<tracking-ref>:<file>` resolution is reliable).
 *      Any absent/stale head → fail-soft null: the real push is ground truth.
 *
 * Staged deletions have no blob → not a create/update → exempt. Any exec
 * failure (timeout, rejected ExecFn) → null — never abort a push on
 * ref-resolution uncertainty.
 * @returns true = every staged workflow file is exempt (GitHub accepts),
 *   false = some file is new/changed on every known server branch (GitHub
 *   would reject), null = couldn't determine authoritatively (fail-soft).
 */
export async function workflowChangesExempt(
	exec: ExecFn,
	cwd: string,
	remote: string,
	stagedWorkflowFiles: string[],
): Promise<boolean | null> {
	try {
		// Remote-tracking refs exist per remote NAME; a URL remote can't be
		// covered authoritatively → fail-soft.
		if (!/^[A-Za-z0-9._-]+$/.test(remote)) return null;
		const lsRemote = await exec("git", ["ls-remote", "--heads", remote], { cwd });
		if (lsRemote.code !== 0) return null;
		const serverHeads = new Map<string, string>(); // branch name -> tip sha
		for (const line of (lsRemote.stdout || "").split("\n")) {
			const [sha, ref] = line.trim().split(/\s+/);
			if (sha && ref && ref.startsWith("refs/heads/")) {
				serverHeads.set(ref.slice("refs/heads/".length), sha);
			}
		}
		if (serverHeads.size === 0) return null; // no server branches to compare against

		// Coverage check: every server head must have a matching local
		// remote-tracking ref (same sha). Any absent/stale head means the local
		// refs don't represent the server → fail-soft.
		const prefix = `refs/remotes/${remote}/`;
		const tracking = await exec(
			"git",
			["for-each-ref", "--format=%(objectname) %(refname)", `refs/remotes/${remote}`],
			{ cwd },
		);
		if (tracking.code !== 0) return null;
		const localTracking = new Map<string, string>(); // tracking refname -> sha
		for (const line of (tracking.stdout || "").split("\n")) {
			const [sha, ref] = line.trim().split(/\s+/);
			if (sha && ref) localTracking.set(ref, sha);
		}
		for (const [name, sha] of serverHeads) {
			if (localTracking.get(`${prefix}${name}`) !== sha) return null;
		}

		for (const file of stagedWorkflowFiles) {
			const staged = await exec("git", ["rev-parse", "--verify", `:${file}`], { cwd });
			if (staged.code !== 0) continue; // staged deletion — no blob, not a create/update
			const stagedSha = staged.stdout.trim();
			let found = false;
			// ponytail: per-head rev-parse loop; batch via `cat-file --batch-check`
			// over stdin if remote-head counts ever make this path measurable.
			for (const name of serverHeads.keys()) {
				const other = await exec("git", ["rev-parse", "--verify", `${prefix}${name}:${file}`], {
					cwd,
				});
				if (other.code === 0 && other.stdout.trim() === stagedSha) {
					found = true;
					break;
				}
			}
			if (!found) return false; // new/changed on every server branch → needs the scope
		}
		return true;
	} catch {
		return null; // fail-soft: never abort a push on ref-resolution uncertainty
	}
}
