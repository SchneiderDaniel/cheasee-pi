// ─── Pipeline Audit: LSP Gate ─────────────────────────────────────
// LSP pre-audit diagnostics via the lsp-auditor client (JSON-RPC over
// stdio). Used as fallback when the TSC checkpoint is unavailable.
// Wire protocol stays in lsp-auditor — this module only invokes the
// gate runner via getRunGate.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import { resolve as resolvePath } from "node:path";
import type { ErrorCollector } from "../error-collector.ts";
import { determineAuditGate, getRunGate } from "../../checks/audit-gate-decision.ts";

/**
 * Run LSP pre-audit diagnostics.
 * Used as fallback when TSC checkpoint is unavailable.
 */
export async function runLspPreAudit(
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath: string,
	collector?: ErrorCollector,
): Promise<{ nextStatus: string; note: string }> {
	const runPreAuditFn = await getRunGate("lsp");
	let preAuditResult: any = null;

	let hasModifiedFiles = true;
	let retryCount = 0;

	if (runPreAuditFn) {
		try {
			const diffResult = await pi.exec("git", ["diff", config.defaultBranch!, "--name-only"], {
				cwd: resolvePath(worktreePath),
				timeout: 10_000,
			});
			hasModifiedFiles = (diffResult.stdout || "").trim().length > 0;
		} catch {
			collector?.push(
				"audit",
				"warn",
				`git diff failed against ${config.defaultBranch} for LSP pre-audit, assuming no modified files`,
			);
			hasModifiedFiles = false;
		}

		const entries = ctx.sessionManager.getEntries();
		retryCount = 0;
		for (const e of entries) {
			if (
				e.type === "custom" &&
				e.customType === "lsp-audit-retry" &&
				e.data &&
				typeof e.data === "object" &&
				"issueNum" in e.data &&
				(e.data as Record<string, unknown>).issueNum === issueNum
			) {
				retryCount++;
			}
		}

		if (hasModifiedFiles) {
			preAuditResult = await runPreAuditFn(
				{
					issueNum,
					worktreePath: worktreePath,
					defaultBranch: config.defaultBranch!,
					repo: config.repo,
				},
				pi,
				ctx,
			);
		}
	}

	// Compute changeAlreadyOnMain: whether the worktree HEAD is identical to
	// the default branch HEAD (no committed or uncommitted differences).
	// When hasModifiedFiles is false AND there are no commits on the branch,
	// the worktree is a clean copy of main — any required changes must
	// already be present on main.
	let changeAlreadyOnMain = false;
	if (!hasModifiedFiles) {
		try {
			const revResult = await pi.exec(
				"git",
				["rev-list", "--count", `${config.defaultBranch}..HEAD`],
				{ cwd: resolvePath(worktreePath), timeout: 10_000 },
			);
			const commitCount = parseInt(revResult.stdout?.trim() || "0", 10);
			changeAlreadyOnMain = commitCount === 0;
		} catch {
			// If git command fails, assume changes not on main (safe: don't skip)
			changeAlreadyOnMain = false;
		}
	}

	const decision = determineAuditGate({
		policyName: "lsp",
		intendedNext: "Audit",
		result: preAuditResult,
		context: { hasModifiedFiles, changeAlreadyOnMain, retryCount },
	});

	if (decision.note) {
		ctx.ui.notify(decision.note, "info");
	}

	return { nextStatus: decision.nextStatus, note: decision.note };
}
