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
import { generateBranchName } from "../../lib/branch-name.ts";
import type { ExecFn } from "../../../lib/port-types.ts";
import { withPerChildEnv } from "../../../lib/exec-env.ts";
import { toExecFn } from "../../../lib/port-adapters.ts";
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
	type CiGateOutcome,
	captureHeadSha,
} from "./pre-gates.ts";
import { runTscGate } from "./tsc-gate.ts";
import { runLspPreAudit } from "./lsp-gate.ts";
import { decideAudit, type AuditGateResults } from "./aggregate.ts";
import { uncommitDeveloperWork } from "../stages/audit-rejection-ops.ts";

/** Test seams for the two heavy gates (production passes nothing). */
export interface AuditOrchestratorDeps {
	runTscGateFn: typeof runTscGate;
	runLspPreAuditFn: typeof runLspPreAudit;
}

/** The CI gate failure section rides along on both verdicts (issue #1829). */
interface CiFailureCarrier {
	ciFailureText: string | null;
}

/**
 * Result of the Implementation → Audit transition.
 *
 * `blocked` (issue #1830) means CI could not be verified: no gate pair ran,
 * nothing is uncommitted, no status may be applied — the caller posts a blocker
 * comment and stops the pipeline.
 */
export type AuditRunResult =
	| ({ outcome: "blocked"; reason: string } & CiFailureCarrier)
	| ({
			outcome: "transition";
			nextStatus: string;
			note: string;
	  } & AuditGateResults &
			CiFailureCarrier);

/** CI verdicts that let the remaining gates run. */
type CiSettledOutcome = Extract<CiGateOutcome, { kind: "pass" | "fail" }>;

/**
 * Run the six non-transition gates in today's push order, appending each
 * blocking failure's section text to gateFailures. The CI verdict is computed
 * first and returned as a value: an `unverifiable` CI returns `blocked` before
 * any other gate runs, so an unreachable CI never reaches the fail-open paths.
 */
async function runPreGates(
	ctx: ExtensionCommandContext,
	deps: PreGateDeps,
	config: SupervisorConfig,
	worktreePath: string,
	gateFailures: string[],
	expectedHeadSha: string,
): Promise<
	| { blocked: true; reason: string }
	| {
			blocked: false;
			ciOutcome: CiSettledOutcome;
			dupGate: DuplicateGateResult;
			deadGate: DeadCodeGateResult;
			osvGate: OsvGateResult;
			ciFailureText: string | null;
	  }
> {
	// Step 0: CI gating — poll the PR head's check runs before running local hooks
	ctx.ui.setStatus("supervisor", "Polling CI checks...");
	const ciGate = await runCiGate(deps, config, expectedHeadSha);
	if (ciGate.kind === "unverifiable") {
		// Infrastructure, not a code defect: stop instead of looping the developer.
		return { blocked: true, reason: ciGate.reason };
	}
	const ciFailureText = ciGate.kind === "fail" ? ciGate.text : null;
	if (ciFailureText) gateFailures.push(ciFailureText);

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

	return { blocked: false, ciOutcome: ciGate, dupGate, deadGate, osvGate, ciFailureText };
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
	deps: Partial<AuditOrchestratorDeps> = {},
): Promise<AuditRunResult> {
	const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	// Shared exec function for running shell commands via pi.exec
	const exec: ExecFn = withPerChildEnv(toExecFn(pi.exec.bind(pi)));

	// Collect ALL gate failures across every blocking gate.
	// Gates run to completion regardless of individual failures.
	// Developer gets one combined context with every issue at once.
	const gateFailures: string[] = [];

	// Pin the CI gate to the commit this run pushed (issue #1829). Captured
	// before any gate runs so the CI poll can never classify a stale PR head;
	// an empty answer makes the CI gate fail closed instead of passing blind.
	const ciGatingEnabled = (config.ciGatingTimeoutSec ?? 0) > 0;
	const expectedHeadSha = ciGatingEnabled ? await captureHeadSha(exec, worktreePath, ctx.ui) : "";

	// Heavy-gate seams: production gets the real runners, tests get stubs.
	const { runTscGateFn = runTscGate, runLspPreAuditFn = runLspPreAudit } = deps;

	const preGateDeps: PreGateDeps = {
		pi,
		execFn: exec,
		ui: ctx.ui,
		repo: config.repo,
		branch,
		filteredData,
		issueTitle,
	};

	try {
		const preGates = await runPreGates(
			ctx,
			preGateDeps,
			config,
			worktreePath,
			gateFailures,
			expectedHeadSha,
		);
		if (preGates.blocked) {
			// CI could not be verified: stop here. No TSC/LSP/dup gates run and
			// nothing is uncommitted — the developer's commit is preserved.
			getDebugLogger().warn("pipeline-audit", "CI unverifiable — pipeline stopped", {
				reason: preGates.reason,
			});
			return { outcome: "blocked", reason: preGates.reason, ciFailureText: null };
		}
		const { ciOutcome, dupGate, deadGate, osvGate, ciFailureText } = preGates;

		// Step 5: TSC checkpoint (Tier 2)
		// Write checkpoint before TSC (heavy/long-running operation)
		writeAuditCheckpoint(ctx, issueNum, "pre-tsc", "TSC", branch, worktreePath);
		ctx.ui.setStatus("supervisor", "Running TSC checkpoint...");
		const tscFailure = await runTscGateFn(worktreePath, ctx, collector);
		if (tscFailure) gateFailures.push(tscFailure);

		// Step 5: LSP pre-audit (Tier 3)
		// Write checkpoint before LSP (heavy/long-running operation)
		writeAuditCheckpoint(ctx, issueNum, "pre-lsp", "LSP", branch, worktreePath);
		ctx.ui.setStatus("supervisor", "Running LSP pre-audit diagnostics...");
		const lspResult = await runLspPreAuditFn(issueNum, issueTitle, config, pi, ctx, worktreePath);
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
			await uncommitDeveloperWork(
				exec,
				worktreePath,
				config.remote ?? "origin",
				branch,
				ctx.ui,
				collector,
			);
		}
		return {
			...decideAudit(
				gateFailures,
				lspResult.note,
				{
					duplicateCodeResult: dupGate.dupResult,
					deadCodeResult: deadGate.deadResult,
					vulnResult: osvGate.vulnResult,
				},
				ciOutcome,
			),
			ciFailureText,
		};
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
	}
}
