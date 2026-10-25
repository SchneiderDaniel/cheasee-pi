// ─── Workflow-scope rejection marker ────────────────────────────
// GitHub rejects workflow-file pushes from OAuth-app and PAT tokens lacking
// the `workflow` scope. Receive-pack prints the reason in the remote-rejected
// line; both documented variants share the same shape. The rejection never
// appears in a dry-run (receive-pack validation is skipped), so this is the
// ground-truth backstop after the fact — and the marker the error-collector
// panel extracts from (keeps from "remediation:" onward, action-first).

const WORKFLOW_SCOPE_RE =
	/\(\s*refusing to allow (?:an OAuth App|a Personal Access Token).*?without `workflow` scope\)/s;

/** The remote-rejected reason from `git push` output, or null. */
export function workflowRejectionClause(output: string): string | null {
	const match = output.match(WORKFLOW_SCOPE_RE);
	return match ? match[0] : null;
}
