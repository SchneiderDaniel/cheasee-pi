// ─── Pipeline Audit: TSC Gate ─────────────────────────────────────
// Runs the TSC checkpoint (tsc diagnostics collection) and decides
// whether the Implementation→Audit transition is blocked by type
// errors. Compiler API usage stays in tsc-checkpoint/checkpoint.ts —
// this module only invokes the gate runner via getRunGate.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getDebugLogger } from "../../lib/debug.ts";
import type { ErrorCollector } from "../error-collector.ts";
import { determineAuditGate, getRunGate } from "../../checks/audit-gate-decision.ts";
import type { TscCheckpointResult } from "../../../lib/tsc-types.ts";

/**
 * Run the TSC checkpoint gate (Tier 2). Returns the failure-section
 * text for the orchestrator to push onto gateFailures, or null when
 * the gate passes or is unavailable (no tsc runner configured).
 */
export async function runTscGate(
	worktreePath: string,
	ctx: ExtensionCommandContext,
	collector?: ErrorCollector,
): Promise<string | null> {
	const runTscCheckpointFn = await getRunGate("tsc");
	if (!runTscCheckpointFn) return null;

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
	const tscDecision = determineAuditGate({
		policyName: "tsc",
		intendedNext: "Audit",
		result: tscResult,
	});

	getDebugLogger().info("pipeline-audit", "TSC result", {
		nextStatus: tscDecision.nextStatus,
		note: tscDecision.note,
	});

	let failureText: string | null = null;
	if (tscDecision.nextStatus !== "Audit") {
		// TSC has errors — add to gate failures, continue to LSP
		if (tscDecision.note) {
			ctx.ui.notify(tscDecision.note, "warning");
		}
		failureText = `--- TypeScript Checkpoint ---\n${tscDecision.note}`;
	}

	// TSC clean — proceed to LSP pre-audit
	if (tscDecision.note) {
		ctx.ui.notify(tscDecision.note, "info");
	}
	return failureText;
}
