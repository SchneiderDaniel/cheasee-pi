// ─── Pipeline Output Helpers ─────────────────────────────────────
// Summary building, agent result validation, PR creation helpers.
// Extracted from pipeline.ts to keep that file under 300 lines.

import type {
	AgentRunResult,
	PipelineAgentResult,
	SupervisorConfig,
	PrCreationResult,
} from "../config/types.ts";
import { formatDuration, formatTokens } from "../lib/formatting.ts";

// ─── validateAgentResult ────────────────────────────────────────────

/**
 * Sanity-check agent result: if success=true with 0 tokens and >5 tool calls,
 * the agent likely timed out or aborted before completion. Derate to failed.
 */
export function validateAgentResult(result: AgentRunResult): void {
	if (result.success && result.tokenCount === 0 && result.toolCount > 5) {
		result.success = false;
		const existingError = result.errorOutput ? result.errorOutput + "\n" : "";
		result.errorOutput = `${existingError}Sanity check failed: success=true with tokenCount=0 and toolCount=${result.toolCount}. This indicates a timeout or abort before completion.`;
	}
}

// ─── Pipeline summary builder ───────────────────────────────────────

/**
 * Build markdown summary of pipeline results.
 * Accepts optional PrCreationResult to include PR creation status.
 * Accepts optional gateFailureHistory to include gate failure context
 * in the PR body (R2 requirement).
 */
export function buildPipelineSummary(
	agentResults: PipelineAgentResult[],
	overallStatus: "success" | "failed" | "stopped",
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	stopReason?: string,
	prCreationResult?: PrCreationResult,
	gateFailureHistory?: string[],
): string {
	const lines: string[] = [];

	// Header — adjust for PR creation failure
	const isPrFailed = prCreationResult && !prCreationResult.success;
	const effectiveStatus = isPrFailed && overallStatus === "success" ? "pr-failed" : overallStatus;

	const headerEmoji =
		effectiveStatus === "success"
			? "✅"
			: effectiveStatus === "pr-failed"
				? "⚠️"
				: effectiveStatus === "failed"
					? "❌"
					: "⏹";
	const headerText =
		effectiveStatus === "success"
			? "Pipeline Complete"
			: effectiveStatus === "pr-failed"
				? "Pipeline Complete (PR creation failed)"
				: effectiveStatus === "failed"
					? "Pipeline Failed"
					: "Pipeline Stopped";
	lines.push(`## ${headerEmoji} ${headerText} — Issue #${issueNum}`);
	lines.push("");

	// Helper to extract short model name (after slash)
	const shortModel = (m?: string) => (m ? m.split("/").pop() || m : "—");

	// Agent table
	lines.push("| Agent | Status | Duration | Tokens | Tools | Model |");
	lines.push("|-------|--------|----------|--------|-------|-------|");
	if (agentResults.length > 0) {
		for (const ar of agentResults) {
			const statusIcon = ar.status === "FAILED" ? "✗" : "✓";
			// Append error output for failed agents to surface crash diagnostics
			// e.g., "Failed to start: ENOENT" instead of just "FAILED" (Bug #711 fix)
			let statusDisplay = `${statusIcon} ${ar.status}`;
			if (ar.status === "FAILED" && ar.errorOutput) {
				const truncated =
					ar.errorOutput.length > 80 ? ar.errorOutput.slice(0, 80) + "..." : ar.errorOutput;
				statusDisplay += ` (${truncated})`;
			}
			lines.push(
				`| ${ar.agentName} | ${statusDisplay} | ${formatDuration(ar.durationMs)} | ${formatTokens(ar.tokenCount)} | ${ar.toolCount} | ${shortModel(ar.model)} |`,
			);
		}
	} else {
		lines.push("| (none) | — | — | — | — | — |");
	}
	lines.push("");

	// Total stats
	const totalTokens = agentResults.reduce((sum, a) => sum + a.tokenCount, 0);
	const totalDurationMs = agentResults.reduce((sum, a) => sum + a.durationMs, 0);
	const totalToolCalls = agentResults.reduce((sum, a) => sum + a.toolCount, 0);
	const totalFailedCalls = agentResults.reduce((sum, a) => sum + (a.failedToolCount ?? 0), 0);
	const failedPercentage =
		totalToolCalls > 0 ? ((totalFailedCalls / totalToolCalls) * 100).toFixed(0) : "0";
	const failedSuffix =
		totalFailedCalls > 0 || agentResults.some((a) => a.failedToolCount !== undefined)
			? ` · ${totalFailedCalls} failed (${failedPercentage}%)`
			: "";
	lines.push(
		`**Total:** ${agentResults.length} agents · ${formatDuration(totalDurationMs)} · ${formatTokens(totalTokens)} tokens · ${totalToolCalls} tool calls${failedSuffix}`,
	);

	// Issue link + auto-link PR to issue (cross-reference in GitHub UI)
	lines.push(`**Issue:** https://github.com/${config.repo}/issues/${issueNum}`);
	lines.push(`Closes #${issueNum}`);

	// PR creation status
	if (prCreationResult) {
		if (prCreationResult.success) {
			const action = prCreationResult.wasUpdate ? "updated" : "created";
			const prLink = prCreationResult.prNumber
				? `https://github.com/${config.repo}/pull/${prCreationResult.prNumber}`
				: "(unknown)";
			lines.push(`**PR:** ${action} — [#${prCreationResult.prNumber}](${prLink})`);
		} else {
			lines.push(`**PR creation failed:** ${prCreationResult.error || "Unknown error"}`);
		}
	}

	// Stop reason for stopped pipelines
	if (overallStatus === "stopped" && stopReason) {
		lines.push("");
		lines.push(`**Stopped at:** ${stopReason}`);
	}

	// Gate failure history
	if (gateFailureHistory && gateFailureHistory.length > 0) {
		lines.push("");
		lines.push("**Gate failures:**");
		for (const entry of gateFailureHistory) {
			lines.push(`- ${entry}`);
		}
	}

	// Failure info
	if (overallStatus === "failed") {
		const failedAgent = [...agentResults].reverse().find((a) => a.status === "FAILED");
		if (failedAgent) {
			lines.push("");
			lines.push(`**Stopped at:** ${failedAgent.agentName} — agent failed`);
		}
		lines.push("**Manual intervention required.**");
	}

	return lines.join("\n");
}
