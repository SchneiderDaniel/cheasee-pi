// ─── Workflow-scope gate ────────────────────────────────────────
// Pre-push gate: if the staged diff touches .github/workflows/ and the token
// provably lacks the workflow scope, fail before the pack round-trip — unless
// the identical-file exemption applies (workflow-exempt.ts). Fail-soft on any
// introspection or ref-resolution uncertainty: the real push is ground truth.

import type { ExecFn } from "../../lib/port-types.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { detectTokenClass, ghRaw, type TokenClass } from "./gh-client.ts";
import { workflowChangesExempt } from "./workflow-exempt.ts";

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
		const scopes = header[1]!
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		return scopes.includes("workflow");
	} catch (err) {
		getDebugLogger().warn(
			"git",
			"workflow-scope introspection failed — proceeding with push (server is ground truth)",
			{
				error: String(err),
			},
		);
		return null;
	}
}

/** The pre-push gate: an error message to abort with, or null to proceed. */
export async function assertWorkflowScopeForPush(
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
