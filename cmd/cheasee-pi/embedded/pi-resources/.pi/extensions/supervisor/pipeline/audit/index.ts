// ─── Pipeline Audit ──────────────────────────────────────────────
// Orchestrator for the Implementation→Audit transition: runs ALL
// pre-transition gates (CI, duplicate, dead code, package safety,
// OSV, traceability, TSC, LSP), aggregates every failure into one
// combined note, and decides Implementation (any gate failed) vs
// Audit (all passed). Gate logic lives in the sibling modules
// (pre-gates, tsc-gate, lsp-gate, aggregate); this module owns the
// setStatus lifecycle, checkpoint writes, and gate sequencing.
//
// Helpers are defined above the orchestrator so the status-cleanup
// scan sees every setStatus line before the single finally clear.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import { generateBranchName } from "../../agent/task.ts";
import type { ExecFn } from "../helpers.ts";
import type { ErrorCollector } from "../error-collector.ts";
import { writeCheckpointFile, type CheckpointName } from "../state-checkpoint.ts";
import {
	runCiGate,
	runDuplicateGate,
	runDeadCodeGate,
	runPackageSafetyGate,
	runOsvGate,
	runTraceabilityGate,
	type PreGateDeps,
	type DuplicateGateResult,
	type DeadCodeGateResult,
	type OsvGateResult,
} from "./pre-gates.ts";
import { runTscGate } from "./tsc-gate.ts";
import { runLspPreAudit } from "./lsp-gate.ts";
import { decideAudit } from "./aggregate.ts";
import type { DuplicateCodeResult } from "../../checks/duplicate-code.ts";
import type { DeadCodeResult } from "../../checks/dead-code.ts";
import type { OsvScanResult } from "../../checks/osv-scanner.ts";

/**
 * Run the six non-transition gates in today's push order, appending each
 * blocking failure's section text to gateFailures. Returns the gate results
 * the orchestrator threads into the final decision.
 */
async function runPreGates(
	ctx: ExtensionCommandContext,
	deps: PreGateDeps,
	config: SupervisorConfig,
	worktreePath: string,
	gateFailures: string[],
): Promise<{ dupGate: DuplicateGateResult; deadGate: DeadCodeGateResult; osvGate: OsvGateResult }> {
	// Step 0: CI gating — poll check runs before running local hooks
	if (config.ciGatingTimeoutSec && config.ciGatingTimeoutSec > 0) {
		ctx.ui.setStatus("supervisor", "Polling CI checks...");
	}
	const ciGate = await runCiGate(deps, config, worktreePath);
	if (ciGate.failureText) gateFailures.push(ciGate.failureText);

	// Step 1: Duplicate code detection gate (non-blocking)
	ctx.ui.setStatus("supervisor", "Checking for duplicate code...");
	const dupGate = await runDuplicateGate(deps, config, worktreePath);

	// Step 1b: Dead code detection gate (BLOCKING)
	ctx.ui.setStatus("supervisor", "Checking for dead code...");
	const deadGate = await runDeadCodeGate(deps, config, worktreePath);
	if (deadGate.failureText) gateFailures.push(deadGate.failureText);

	// Step 2: Package safety audit (non-blocking — informational)
	ctx.ui.setStatus("supervisor", "Checking package safety...");
	await runPackageSafetyGate(deps, config, worktreePath);

	// Step 2b: OSV vulnerability scan gate (blocking when configured)
	ctx.ui.setStatus("supervisor", "Running OSV vulnerability scan...");
	const osvGate = await runOsvGate(deps, config, worktreePath);
	if (osvGate.failureText) gateFailures.push(osvGate.failureText);

	// Step 4: Requirements traceability check (non-blocking — informational)
	ctx.ui.setStatus("supervisor", "Running requirements traceability checks...");
	await runTraceabilityGate(deps, config, worktreePath);

	return { dupGate, deadGate, osvGate };
}

/**
 * Write a checkpoint file before a heavy gate (TSC/LSP) for crash recovery.
 * Notifies (warning) when the write fails.
 */
function writeAuditCheckpoint(
	ctx: ExtensionCommandContext,
	issueNum: number,
	checkpoint: CheckpointName,
	displayName: string,
	branch: string,
	worktreePath: string,
): void {
	const checkpointResult = writeCheckpointFile(ctx.cwd, {
		issueNum,
		checkpoint,
		worktreePath: worktreePath,
		worktreeBranch: branch,
		startedAt: new Date().toISOString(),
	});
	if (!checkpointResult.ok) {
		ctx.ui.notify(
			`Warning: Failed to write pre-${displayName} checkpoint: ${checkpointResult.error}`,
			"warning",
		);
	}
}

/**
 * Run ALL pre-transition checks during Implementation → Audit transition.
 * Includes CI gating, duplicate code check, package safety,
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
	vulnResult?: OsvScanResult;
}> {
	const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	// Shared exec function for running shell commands via pi.exec
	const execFn: ExecFn = (cmd, args, opts) => pi.exec(cmd, args, opts);

	// Collect ALL gate failures across every blocking gate.
	// Gates run to completion regardless of individual failures.
	// Developer gets one combined context with every issue at once.
	const gateFailures: string[] = [];

	const preGateDeps: PreGateDeps = {
		pi,
		execFn,
		ui: ctx.ui,
		repo: config.repo,
		branch,
		filteredData,
		issueTitle,
	};

	try {
		const { dupGate, deadGate, osvGate } = await runPreGates(
			ctx,
			preGateDeps,
			config,
			worktreePath,
			gateFailures,
		);

		// Step 5: TSC checkpoint (Tier 2)
		// Write checkpoint before TSC (heavy/long-running operation)
		writeAuditCheckpoint(ctx, issueNum, "pre-tsc", "TSC", branch, worktreePath);
		ctx.ui.setStatus("supervisor", "Running TSC checkpoint...");
		const tscFailure = await runTscGate(worktreePath, ctx, collector);
		if (tscFailure) gateFailures.push(tscFailure);

		// Step 5: LSP pre-audit (Tier 3)
		// Write checkpoint before LSP (heavy/long-running operation)
		writeAuditCheckpoint(ctx, issueNum, "pre-lsp", "LSP", branch, worktreePath);
		ctx.ui.setStatus("supervisor", "Running LSP pre-audit diagnostics...");
		const lspResult = await runLspPreAudit(issueNum, issueTitle, config, pi, ctx, worktreePath);
		getDebugLogger().info("pipeline-audit", "LSP pre-audit result", {
			nextStatus: lspResult.nextStatus,
			note: lspResult.note,
		});
		if (lspResult.nextStatus !== "Audit") {
			gateFailures.push(`--- LSP Pre-Audit ---\n${lspResult.note}`);
		}

		// After ALL gates: if any blocking failure, uncommit once so the
		// developer resumes with context intact, then return combined context
		if (gateFailures.length > 0) {
			await uncommitDeveloperWork(execFn, worktreePath);
		}
		return decideAudit(gateFailures, lspResult.note, {
			duplicateCodeResult: dupGate.dupResult,
			deadCodeResult: deadGate.deadResult,
			vulnResult: osvGate.vulnResult,
		});
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
	}
}

/**
 * Uncommit the developer's most recent commit in the worktree.
 * Uses `git reset --soft HEAD~1` to preserve changes as staged modifications
 * so the developer resumes with context intact when a pre-transition gate fails.
 *
 * Gate failures (dead code, CI, TSC, LSP) should NOT result in fresh context
 * for the developer — only auditor rejections should. By uncommitting, the
 * worktree keeps the changes, and the developer sees them on next dispatch.
 *
 * Fail-safe: if no commit exists (e.g., developer made no changes), the error
 * is silently caught — the worktree is already in the desired state.
 */
async function uncommitDeveloperWork(execFn: ExecFn, worktreePath: string): Promise<void> {
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
