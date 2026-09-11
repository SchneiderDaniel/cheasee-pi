// ─── Git Operations ──────────────────────────────────────────────
// commitChanges, pushBranch, commitAndPush.
// pushBranch and commitAndPush return Result<T> for explicit failure handling.

import type { ExecFn } from "../pipeline/helpers.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { withNotify, type Result } from "../pipeline/result.ts";
import type { NotifyFn } from "../pipeline/helpers.ts";
import { ghRaw, detectTokenClass, type TokenClass } from "./gh-client.ts";

// GitHub rejects workflow-file pushes from OAuth-app and PAT tokens lacking
// the `workflow` scope. Receive-pack prints the reason in the remote-rejected
// line; both documented variants share the same shape. The rejection never
// appears in a dry-run (receive-pack validation is skipped), so this is the
// ground-truth backstop after the fact — and the marker the error-collector
// panel extracts from (keeps from "remediation:" onward, action-first).
const WORKFLOW_SCOPE_RE =
	/\(\s*refusing to allow (?:an OAuth App|a Personal Access Token).*?without `workflow` scope\)/s;

function workflowRejectionClause(output: string): string | null {
	const match = output.match(WORKFLOW_SCOPE_RE);
	return match ? match[0] : null;
}

/**
 * Token-class-keyed remediation hint for the workflow-scope rejection.
 * cheasee-pi init-minted tokens cannot be upgraded by `gh auth refresh`
 * (gh exits 4; the container overrides gh's store with auth.json on start),
 * so only re-running the device flow adds the scope.
 */
export function workflowScopeHint(tokenClass: TokenClass): string {
	if (tokenClass === "cheasee-pi") {
		return "run `cheasee-pi init --reauth` to mint a token with the workflow scope";
	}
	if (tokenClass === "gh") {
		return "run `gh auth refresh -h github.com -s workflow` to add the workflow scope";
	}
	return "run `cheasee-pi init --reauth` (cheasee-pi token) or `gh auth refresh -h github.com -s workflow` (gh token)";
}

/**
 * Introspect the token's granted scopes via the X-OAuth-Scopes header on
 * GET /user (one API call, no pack transfer). null = unknown (header absent,
 * e.g. fine-grained App token, or introspection failed) → callers fail-soft.
 */
async function tokenHasWorkflowScope(exec: ExecFn): Promise<boolean | null> {
	try {
		const result = await ghRaw(exec, ["api", "-i", "/user"]);
		if (result.code !== 0) return null;
		const output = (result.stdout || "") + (result.stderr || "");
		const header = output.match(/^x-oauth-scopes:\s*(.*)$/im);
		if (!header) return null;
		const scopes = header[1]!.split(",").map((s) => s.trim()).filter(Boolean);
		return scopes.includes("workflow");
	} catch (err) {
		getDebugLogger().warn("git", "workflow-scope introspection failed — proceeding with push (server is ground truth)", {
			error: String(err),
		});
		return null;
	}
}

/**
 * GitHub's `workflow`-scope exemption: pushing workflow files that already
 * exist byte-identically (same path AND content) on another branch of the repo
 * needs no scope. The exemption is judged against the SERVER's branch picture,
 * so local enumeration alone is never authoritative — a branch created or
 * advanced since the last fetch is invisible locally and must not cause a
 * false abort. Instead:
 *   1. `git ls-remote --heads <remote>` lists the server's branch tips (a ref
 *      advertisement — no pack transfer, unlike a fetch).
 *   2. Coverage is authoritative only if every server head has a matching
 *      local remote-tracking ref with the same sha (that fetch also brought
 *      the trees/blobs, so `<tracking-ref>:<file>` resolution is reliable).
 *      Any absent/stale head → fail-soft null: the real push is ground truth
 *      and the pushBranch hint is the backstop.
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
				const other = await exec(
					"git",
					["rev-parse", "--verify", `${prefix}${name}:${file}`],
					{ cwd },
				);
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

/**
 * Pre-push gate: if the staged diff touches .github/workflows/ and the token
 * provably lacks the workflow scope, fail before the pack round-trip — unless
 * the identical-file exemption applies (workflowChangesExempt). Fail-soft on
 * any introspection or ref-resolution uncertainty — the real push is ground
 * truth.
 */
async function assertWorkflowScopeForPush(
	exec: ExecFn,
	cwd: string,
	remote: string,
	stagedFiles: string[],
): Promise<string | null> {
	const log = getDebugLogger();
	const workflowFiles = stagedFiles.filter((f) => f.startsWith(".github/workflows/"));
	if (workflowFiles.length === 0) {
		return null;
	}
	const hasScope = await tokenHasWorkflowScope(exec);
	if (hasScope !== false) return null; // has it, or unknown → proceed
	const exempt = await workflowChangesExempt(exec, cwd, remote, workflowFiles);
	if (exempt !== false) return null; // identical on a server branch, or unknown → proceed (real push is ground truth)
	log.error("git", "pre-push gate: token lacks workflow scope for a workflow-touching diff", {
		cwd,
		files: workflowFiles,
	});
	return `git push aborted: the staged diff touches .github/workflows/ but the token lacks the workflow scope — remediation: ${workflowScopeHint(detectTokenClass())}`;
}

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
				const forceResult = await exec(
					"git",
					["push", "--force-with-lease", remote, branch],
					{
						cwd,
					},
				);
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
		const diffResult = await exec("git", ["diff", "--cached", "--name-only", "--exit-code"], { cwd });
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
