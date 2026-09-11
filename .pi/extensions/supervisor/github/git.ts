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
 * Pre-push gate: if the staged diff touches .github/workflows/ and the token
 * provably lacks the workflow scope, fail before the pack round-trip. Fail-soft
 * on any introspection uncertainty — the real push is ground truth. The GitHub
 * identical-path+content exemption edge (same workflow file already on another
 * branch needs no scope) is accepted: such re-deliveries normally produce an
 * empty staged diff and never reach the introspection; content-equal-but-touched
 * stragglers fall through to the real push and the pushBranch hint backstop.
 */
async function assertWorkflowScopeForPush(
	exec: ExecFn,
	cwd: string,
	stagedFiles: string[],
): Promise<string | null> {
	const log = getDebugLogger();
	if (!stagedFiles.some((f) => f.startsWith(".github/workflows/"))) {
		return null;
	}
	const hasScope = await tokenHasWorkflowScope(exec);
	if (hasScope !== false) return null; // has it, or unknown → proceed
	log.error("git", "pre-push gate: token lacks workflow scope for a workflow-touching diff", {
		cwd,
		files: stagedFiles.filter((f) => f.startsWith(".github/workflows/")),
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
			const gateError = await assertWorkflowScopeForPush(exec, cwd, stagedFiles);
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
