// ─── Pipeline Audit ──────────────────────────────────────────────
// TSC checkpoint + LSP pre-audit + duplicate code check orchestration
// during Implementation→Audit transition. Extracted from pipeline.ts
// to keep that file under 300 lines.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, DebugLogger } from "../config/types.ts";
import { resolve as resolvePath } from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import { generateBranchName } from "../agent/task.ts";
import type { ErrorCollector } from "./error-collector.ts";
import {
	determineTscCheckpointDecision,
	getRunTscCheckpoint,
	type TscCheckpointResult,
} from "../checks/tsc-decisions.ts";
import { determineLspPreAuditDecision, getRunPreAudit } from "../checks/lsp-decisions.ts";
import { pollCiChecks } from "../checks/ci-gating.ts";
import { runDuplicateCheck } from "../checks/duplicate-code.ts";
import type { DuplicateCodeResult } from "../checks/duplicate-code.ts";
import { runDeadCodeCheck, buildDeadCodeContext } from "../checks/dead-code.ts";
import type { DeadCodeResult } from "../checks/dead-code.ts";
import { runPackageSafetyAudit } from "../checks/package-safety.ts";
import { postIssueComment } from "../github/index.ts";
import { runTddGate } from "../checks/tdd-gate.ts";
import { runRequirementsTraceability } from "../checks/requirements-traceability.ts";
import { writeCheckpointFile } from "./state-checkpoint.ts";

/**
 * Run ALL pre-transition checks during Implementation → Audit transition.
 * Includes CI gating, duplicate code check, package safety, TDD gate,
 * requirements traceability, TSC checkpoint, and LSP pre-audit.
 *
 * Unlike previous behavior (short-circuit on first failure), this runs ALL
 * blocking gates and aggregates every failure into one combined note.
 * The developer sees ALL issues in one pass instead of fixing one gate at a time.
 * Returns "Implementation" + aggregated note if any gate fails,
 * or "Audit" + last gate note if all pass.
 */
export async function runTscAndLspAudit(
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentName: string,
	filteredData: { body?: string; comments: Array<{ body: string }> },
	worktreePath: string,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	collector?: ErrorCollector,
): Promise<{
	nextStatus: string;
	note: string;
	duplicateCodeResult?: DuplicateCodeResult;
	deadCodeResult?: DeadCodeResult;
}> {
	const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	// Shared exec function for running shell commands via pi.exec
	const execFn = (cmd: string, args: string[], opts?: Record<string, unknown>) =>
		pi.exec(cmd, args, opts);

	// Collect ALL gate failures across every blocking gate.
	// Gates run to completion regardless of individual failures.
	// Developer gets one combined context with every issue at once.
	const gateFailures: string[] = [];

	try {
		// Step 0: CI gating — poll check runs before running local hooks
		if (config.ciGatingTimeoutSec && config.ciGatingTimeoutSec > 0) {
			ctx.ui.setStatus("supervisor", "Polling CI checks...");
			getDebugLogger().info("pipeline-audit", "Polling CI checks", {
				branch,
				timeoutSec: config.ciGatingTimeoutSec,
			});
			const ciResult = await pollCiChecks(
				pi,
				branch,
				config.repo,
				config.ciGatingTimeoutSec,
				worktreePath,
			);

			if (ciResult.status === "failing") {
				const failedNames = ciResult.checks
					.filter(
						(c) =>
							c.conclusion === "failure" ||
							c.conclusion === "cancelled" ||
							c.conclusion === "action_required" ||
							c.conclusion === "timed_out" ||
							c.conclusion === "stale",
					)
					.map((c) => c.name)
					.join(", ");
				ctx.ui.notify(`CI checks failing: ${failedNames}. Continuing with other gates.`, "warning");
				gateFailures.push(`--- CI Gate ---\n${ciResult.message}`);
			}

			if (ciResult.status === "pending") {
				ctx.ui.notify(
					`CI checks still pending after ${config.ciGatingTimeoutSec}s. Proceeding to audit.`,
					"warning",
				);
			}

			if (ciResult.status === "unconfigured") {
				// No CI configured — proceed silently
				getDebugLogger().info("pipeline-audit", ciResult.message);
			}

			if (ciResult.status === "error") {
				ctx.ui.notify(
					`CI check polling issue: ${ciResult.message}. Proceeding to audit.`,
					"warning",
				);
			}
		}

		// Step 1: Duplicate code detection gate
		// Runs on full worktree and filters clones to changed files.
		// Non-blocking — duplicates found are surfaced as warning and
		// verified by the auditor agent.
		ctx.ui.setStatus("supervisor", "Checking for duplicate code...");
		getDebugLogger().info("pipeline-audit", "Running duplicate code check", { worktreePath });
		const dupResult = await runDuplicateCheck(execFn, worktreePath, config.defaultBranch || "main");

		if (dupResult.status === "duplicates_found") {
			ctx.ui.notify(
				`Duplicate code detected: ${dupResult.clones.length} clone(s) found (${dupResult.totalDuplicateLines} lines). Auditor will verify.`,
				"warning",
			);
			getDebugLogger().info("pipeline-audit", "Duplicates found", {
				cloneCount: dupResult.clones.length,
				totalLines: dupResult.totalDuplicateLines,
			});
		} else if (dupResult.status === "no_jscpd") {
			getDebugLogger().info("pipeline-audit", "jscpd not available, skipping duplicate check");
		} else if (dupResult.status === "error") {
			getDebugLogger().warn("pipeline-audit", "Duplicate check error", {
				message: dupResult.message,
			});
		}

		// Step 1b: Dead code detection gate
		// Runs after duplicate code check, before TSC checkpoint.
		// BLOCKING — dead code found rejects transition back to Implementation.
		// Developer must remove dead code before audit can proceed.
		ctx.ui.setStatus("supervisor", "Checking for dead code...");
		getDebugLogger().info("pipeline-audit", "Running dead code check", { worktreePath });
		const deadResult = await runDeadCodeCheck(execFn, worktreePath, config.defaultBranch || "main");

		if (deadResult.status === "dead_found") {
			const findingCount = deadResult.findings.length;
			const totalLines = deadResult.totalDeadLines;
			const msg = `DEAD_CODE_FOUND: ${findingCount} finding(s) found (${totalLines} lines)`;
			ctx.ui.notify(
				`Dead code detected: ${findingCount} finding(s) found (${totalLines} lines). Fix before audit.`,
				"warning",
			);
			getDebugLogger().info("pipeline-audit", "Blocking — dead code found", {
				findingCount,
				totalLines,
			});

			// Post issue comment with dead code details for developer feedback
			const deadContext = buildDeadCodeContext(deadResult);
			try {
				const commentLines = [
					"## 🔴 Dead Code Gate — Implementation Rejected",
					"",
					"The automated dead code check found potential dead code in changed files.",
					"Remove all confirmed dead code before requesting audit.",
					"",
					deadContext || "(see pre-audit gate output for details)",
				];
				await postIssueComment(pi, issueNum, config.repo, commentLines.join("\n"));
			} catch {
				// Comment posting is best-effort
			}

			gateFailures.push(`--- Dead Code Gate ---\n${deadContext || msg}`);
		} else if (deadResult.status === "no_knip") {
			getDebugLogger().info("pipeline-audit", "knip not available, skipping dead code check");
		} else if (deadResult.status === "error") {
			getDebugLogger().warn("pipeline-audit", "Dead code check error", {
				message: deadResult.message,
			});
		}

		// Step 2: Package safety audit (non-blocking — informational)
		// Runs after duplicate code check. Checks all npm dependencies
		// in the worktree's package.json for package age safety.
		ctx.ui.setStatus("supervisor", "Checking package safety...");
		getDebugLogger().info("pipeline-audit", "Running package safety audit", { worktreePath });
		try {
			const safetyResult = await runPackageSafetyAudit(execFn, worktreePath);
			if (safetyResult.status === "blocked") {
				const blockedPkgs = safetyResult.results
					.filter((r) => r.blocked)
					.map((r) => r.packageName)
					.join(", ");
				ctx.ui.notify(
					`Package safety: ${safetyResult.results.filter((r) => r.blocked).length} blocked package(s): ${blockedPkgs}. Auditor may flag this.`,
					"warning",
				);
				getDebugLogger().info("pipeline-audit", "Package safety check found blocked packages", {
					blockedCount: safetyResult.results.filter((r) => r.blocked).length,
					results: safetyResult.results,
				});
			} else if (safetyResult.status === "error") {
				getDebugLogger().warn("pipeline-audit", "Package safety check error", {
					message: safetyResult.message,
				});
			} else {
				getDebugLogger().info("pipeline-audit", "Package safety check passed", {
					checkedCount: safetyResult.results.length,
				});
			}
		} catch (safetyErr: unknown) {
			getDebugLogger().warn("pipeline-audit", "Package safety check threw", {
				error: safetyErr instanceof Error ? safetyErr.message : String(safetyErr),
			});
		}

		// Step 3: TDD gate — deterministic test-first verification
		// Blocks transition if tests weren't written first or test-fail-first fails.
		// Runs after package safety check, before TSC/LSP.
		ctx.ui.setStatus("supervisor", "Running TDD gate...");
		getDebugLogger().info("pipeline-audit", "Running TDD gate", { worktreePath });
		try {
			const tddResult = await runTddGate(
				execFn,
				worktreePath,
				config.defaultBranch || "main",
				config.assertFunctionNames,
			);

			if (tddResult.status === "failed") {
				const failedCheckNames = tddResult.checks
					.filter((c) => !c.passed)
					.map((c) => c.name)
					.join(", ");
				const msg = `TDD gate failed: ${failedCheckNames}. ${tddResult.rejectionReason || ""}`;
				ctx.ui.notify(`TDD gate: ${msg} — continuing with other gates.`, "warning");
				getDebugLogger().info("pipeline-audit", "TDD gate failed", {
					failedChecks: failedCheckNames,
					rejectionReason: tddResult.rejectionReason,
				});
				// Post issue comment with TDD failure details for developer feedback
				try {
					const commentLines = [
						"## 🔴 TDD Gate — Implementation Rejected",
						"",
						"The deterministic TDD gate verified the changes and found issues:",
						"",
					];
					for (const check of tddResult.checks) {
						const icon = check.passed ? "✅" : "❌";
						commentLines.push(
							`${icon} **${check.name}**${check.detail ? ": " + check.detail : ""}`,
						);
					}
					commentLines.push(
						"",
						"Please write tests following the **Test First** approach: write the test, watch it fail, then write the code.",
					);
					await postIssueComment(pi, issueNum, config.repo, commentLines.join("\n"));
				} catch {
					// Comment posting is best-effort
				}

				// Build detailed gate failure context for developer prompt
				const detailLines = tddResult.checks
					.map((c) => {
						const icon = c.passed ? "✅" : "❌";
						return `${icon} ${c.name}${c.detail ? ": " + c.detail : ""}`;
					})
					.join("\n");
				const fullMsg = `TDD gate failed.\n\nChecks:\n${detailLines}\n\n${tddResult.rejectionReason || ""}`;
				gateFailures.push(`--- TDD Gate ---\n${fullMsg}`);
			}

			if (tddResult.status === "error") {
				ctx.ui.notify(
					`TDD gate error: ${tddResult.rejectionReason || "unknown error"}. Proceeding to audit.`,
					"info",
				);
				getDebugLogger().warn("pipeline-audit", "TDD gate error", {
					rejectionReason: tddResult.rejectionReason,
				});
				// Non-blocking on error — proceed to audit
			} else {
				ctx.ui.notify("TDD gate passed — TDD cycle confirmed.", "info");
				getDebugLogger().info("pipeline-audit", "TDD gate passed");
			}
		} catch (tddErr: unknown) {
			const tddMsg = tddErr instanceof Error ? tddErr.message : String(tddErr);
			ctx.ui.notify(`TDD gate threw: ${tddMsg}. Proceeding to audit.`, "warning");
			getDebugLogger().warn("pipeline-audit", "TDD gate threw", { error: tddMsg });
		}

		// Step 4: Requirements traceability check (non-blocking — informational)
		// Runs deterministic checks cross-referencing issue requirements against the diff.
		// Produces structured gap list surfaced to the auditor agent.
		ctx.ui.setStatus("supervisor", "Running requirements traceability checks...");
		getDebugLogger().info("pipeline-audit", "Running requirements traceability", { worktreePath });
		try {
			const traceGaps = await runRequirementsTraceability(
				execFn,
				worktreePath,
				config.defaultBranch || "main",
				{
					body: filteredData?.body || "",
					comments: (filteredData?.comments || []).map((c: { body: string }) => ({
						author: "unknown",
						body: c.body,
					})),
				},
				issueTitle,
			);
			if (traceGaps.length > 0) {
				const gapSummary = traceGaps
					.map((g) => `[${g.severity}] ${g.check}: ${g.detail}`)
					.join("; ");
				ctx.ui.notify(
					`Requirements traceability: ${traceGaps.length} gap(s) found. Auditor will review.`,
					"info",
				);
				getDebugLogger().info("pipeline-audit", "Traceability gaps found", {
					gapCount: traceGaps.length,
					summary: gapSummary,
				});
			} else {
				getDebugLogger().info("pipeline-audit", "No traceability gaps found");
			}
		} catch (traceErr: unknown) {
			const traceMsg = traceErr instanceof Error ? traceErr.message : String(traceErr);
			ctx.ui.notify(`Requirements traceability check threw: ${traceMsg}`, "info");
			getDebugLogger().warn("pipeline-audit", "Requirements traceability threw", {
				error: traceMsg,
			});
		}

		// Step 5: TSC checkpoint (Tier 2)
		// Write checkpoint before TSC (heavy/long-running operation)
		{
			const checkpointResult = writeCheckpointFile(ctx.cwd, {
				issueNum,
				checkpoint: "pre-tsc",
				worktreePath: worktreePath,
				worktreeBranch: branch,
				startedAt: new Date().toISOString(),
			});
			if (!checkpointResult.ok) {
				ctx.ui.notify(
					`Warning: Failed to write pre-TSC checkpoint: ${checkpointResult.error}`,
					"warning",
				);
			}
		}
		const runTscCheckpointFn = await getRunTscCheckpoint();

		if (runTscCheckpointFn) {
			ctx.ui.setStatus("supervisor", "Running TSC checkpoint...");
			getDebugLogger().info("pipeline-audit", "Running TSC checkpoint", { worktreePath });
			let tscResult: TscCheckpointResult | null = null;
			try {
				tscResult = await runTscCheckpointFn(worktreePath);
			} catch (tscErr: unknown) {
				const tscMsg = tscErr instanceof Error ? tscErr.message : String(tscErr);
				ctx.ui.notify(`TSC checkpoint threw: ${tscMsg}. Proceeding to audit.`, "warning");
				getDebugLogger().warn("pipeline-audit", "TSC checkpoint threw", { error: tscMsg });
				collector?.push("pipeline-audit", "warn", `TSC checkpoint threw: ${tscMsg}`);
			}
			const tscDecision = await determineTscCheckpointDecision(tscResult, "Audit");

			getDebugLogger().info("pipeline-audit", "TSC result", {
				nextStatus: tscDecision.nextStatus,
				note: tscDecision.note,
			});

			if (tscDecision.nextStatus !== "Audit") {
				// TSC has errors — add to gate failures, continue to LSP
				if (tscDecision.note) {
					ctx.ui.notify(tscDecision.note, "warning");
				}
				gateFailures.push(`--- TypeScript Checkpoint ---\n${tscDecision.note}`);
			}

			// TSC clean — proceed to LSP pre-audit
			if (tscDecision.note) {
				ctx.ui.notify(tscDecision.note, "info");
			}
		}

		// Step 5: LSP pre-audit (Tier 3)
		// Write checkpoint before LSP (heavy/long-running operation)
		{
			const checkpointResult = writeCheckpointFile(ctx.cwd, {
				issueNum,
				checkpoint: "pre-lsp",
				worktreePath: worktreePath,
				worktreeBranch: branch,
				startedAt: new Date().toISOString(),
			});
			if (!checkpointResult.ok) {
				ctx.ui.notify(
					`Warning: Failed to write pre-LSP checkpoint: ${checkpointResult.error}`,
					"warning",
				);
			}
		}
		const lspResult = await runLspPreAudit(issueNum, issueTitle, config, pi, ctx, worktreePath);
		getDebugLogger().info("pipeline-audit", "LSP pre-audit result", {
			nextStatus: lspResult.nextStatus,
			note: lspResult.note,
		});
		if (lspResult.nextStatus !== "Audit") {
			gateFailures.push(`--- LSP Pre-Audit ---\n${lspResult.note}`);
		}

		// After ALL gates: if any blocking failure, uncommit once and return combined context
		if (gateFailures.length > 0) {
			await uncommitDeveloperWork(execFn, worktreePath);
			const combinedNote = gateFailures.join("\n\n");
			return {
				nextStatus: "Implementation",
				note: `The following gates blocked the transition from Implementation to Audit:\n\n${combinedNote}`,
				duplicateCodeResult: dupResult,
				deadCodeResult: deadResult,
			};
		}

		// All gates passed — proceed to Audit
		return {
			nextStatus: "Audit",
			note: lspResult.note || "",
			duplicateCodeResult: dupResult,
			deadCodeResult: deadResult,
		};
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
	}
}

/**
 * Run LSP pre-audit diagnostics.
 * Used as fallback when TSC checkpoint is unavailable.
 */
async function runLspPreAudit(
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath: string,
	collector?: ErrorCollector,
): Promise<{ nextStatus: string; note: string }> {
	const runPreAuditFn = await getRunPreAudit();
	let preAuditResult: any = null;

	try {
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
				ctx.ui.setStatus("supervisor", "Running LSP pre-audit diagnostics...");
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

		const decision = determineLspPreAuditDecision(
			"Audit",
			preAuditResult,
			retryCount,
			hasModifiedFiles,
		);

		if (decision.note) {
			ctx.ui.notify(decision.note, "info");
		}

		return { nextStatus: decision.nextStatus, note: decision.note };
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
	}
}

/**
 * Uncommit the developer's most recent commit in the worktree.
 * Uses `git reset --soft HEAD~1` to preserve changes as staged modifications
 * so the developer resumes with context intact when a pre-transition gate fails.
 *
 * Gate failures (dead code, CI, TDD, TSC, LSP) should NOT result in fresh context
 * for the developer — only auditor rejections should. By uncommitting, the
 * worktree keeps the changes, and the developer sees them on next dispatch.
 *
 * Fail-safe: if no commit exists (e.g., developer made no changes), the error
 * is silently caught — the worktree is already in the desired state.
 */
async function uncommitDeveloperWork(
	execFn: (
		cmd: string,
		args: string[],
		opts?: Record<string, unknown>,
	) => Promise<{ code: number; stdout: string; stderr: string }>,
	worktreePath: string,
): Promise<void> {
	try {
		await execFn("git", ["reset", "--soft", "HEAD~1"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		getDebugLogger().info("pipeline-audit", "Uncommitted developer work after gate failure", {
			worktreePath,
		});
	} catch {
		// No commit to uncommit — developer may not have made changes, or
		// there are edge cases (initial commit, detached HEAD). Silent skip.
		getDebugLogger().debug("pipeline-audit", "No commit to uncommit — worktree clean or error", {
			worktreePath,
		});
	}
}
