// ─── Auditor conditional blocks ─────────────────────────────────
// The worktree-verification, pre-audit gate (duplicates, dead code,
// vulnerabilities) and prior-rejection re-verify sections of the auditor
// prompt. Split out of task.ts (issue #2033); each returns "" when it does not
// apply.

/** Where the auditor's cwd is, and how to prefix shell commands. */
export function worktreeBlock(
	worktreePath: string | undefined,
	branch: string,
	branchName: string | undefined,
): string {
	if (!worktreePath) return "";
	return `\n### Worktree Context\nYour current working directory IS the worktree at \`${worktreePath}\`.\nBefore any bash command, verify: \`pwd\` and \`git branch --show-current\`.\nWhen running shell commands, prepend: \`cd ${worktreePath} && <command>\`\nThe worktree branch is ${branchName || branch}.\n`;
}

/** Pre-audit duplicate code context — injected when the pipeline found clones. */
export function duplicateCodeBlock(duplicateCodeContext?: string | null): string {
	if (!duplicateCodeContext) return "";
	return `\n### ⚠️ Duplicate Code Detected (Pre-Audit Gate)\nThe automated duplicate code check found potential clones involving your changed files.\nPlease verify these findings and include them in your audit if confirmed.\n\n${duplicateCodeContext}\n`;
}

/** Pre-audit dead code context — injected when the pipeline found dead code. */
export function deadCodeBlock(deadCodeContext?: string | null): string {
	if (!deadCodeContext) return "";
	return `\n### ⚠️ Dead Code Detected (Pre-Audit Gate)\nThe automated dead code check found potential dead code in your changed files.\nPlease verify these findings and include them in your audit if confirmed.\n\n${deadCodeContext}\n`;
}

/** Pre-audit OSV vulnerability context — injected when the pipeline found CVEs. */
export function vulnBlock(vulnContext?: string | null): string {
	if (!vulnContext) return "";
	return `\n### ⚠️ Vulnerabilities Detected (Pre-Audit Gate)\nThe automated OSV vulnerability scan found known CVEs in project dependencies.\nPlease verify these findings and include them in your audit if confirmed.\n\n${vulnContext}\n`;
}

/**
 * Prior-rejection re-verify block (issue #2044) — the pipeline updates the prior
 * rejection in place, so the auditor must re-check each old finding against the
 * current code and drop the ones already fixed.
 */
export function reVerifyBlock(auditFeedback?: string | null): string {
	if (!auditFeedback) return "";
	return `\n### ♻️ Prior Rejection — Re-verify Against Current Code\n\nThe pipeline replaces your prior rejection comment with this run's verdict. Re-verify EACH finding below against the CURRENT code and emit a refreshed rejection listing ONLY findings that are still present. Do NOT re-list findings the developer has already fixed.\n\n${auditFeedback}\n`;
}
