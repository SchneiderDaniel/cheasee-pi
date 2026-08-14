// ─── Pipeline Output Helpers ─────────────────────────────────────
// Summary building, agent result validation, PR creation helpers.
// Extracted from pipeline.ts to keep that file under 300 lines.

import type {
	AgentRunResult,
	PipelineAgentResult,
	SupervisorConfig,
	PrCreationResult,
} from "../config/types.ts";
import type { PackageSafetyAuditResult } from "../checks/package-safety.ts";
import { formatDuration, formatTokens } from "../lib/formatting.ts";

// ─── Status display mapping ──────────────────────────────────────────

type EffectiveStatus = "success" | "pr-failed" | "failed" | "stopped";

const STATUS_MAP: Record<EffectiveStatus, { emoji: string; text: string }> = {
	success: { emoji: "✅", text: "Pipeline Complete" },
	"pr-failed": { emoji: "⚠️", text: "Pipeline Complete (PR creation failed)" },
	failed: { emoji: "❌", text: "Pipeline Failed" },
	stopped: { emoji: "⏹", text: "Pipeline Stopped" },
};

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
	// undefined when supervisor config failed to load (top-level catch) —
	// the summary degrades to a bare #N link instead of crashing.
	config: SupervisorConfig | undefined,
	stopReason?: string,
	prCreationResult?: PrCreationResult,
	gateFailureHistory?: string[],
	packageSafetyResult?: PackageSafetyAuditResult | null,
	errorMsg?: string,
): string {
	const lines: string[] = [];

	// Header — adjust for PR creation failure
	const isPrFailed = prCreationResult && !prCreationResult.success;
	const effectiveStatus = isPrFailed && overallStatus === "success" ? "pr-failed" : overallStatus;

	const { emoji: headerEmoji, text: headerText } = STATUS_MAP[effectiveStatus];
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
	// Each entry is one dispatch (retries push their own row), so the count
	// is runs, not distinct agents (issue #1495).
	const runCount = agentResults.length;
	const runLabel = `${runCount} ${runCount === 1 ? "run" : "runs"}`;
	lines.push(
		`**Total:** ${runLabel} · ${formatDuration(totalDurationMs)} · ${formatTokens(totalTokens)} tokens · ${totalToolCalls} tool calls${failedSuffix}`,
	);

	// Issue link + auto-link PR to issue (cross-reference in GitHub UI)
	// config undefined → config load failed; drop repo link, keep bare #N
	lines.push(
		config
			? `**Issue:** https://github.com/${config.repo}/issues/${issueNum}`
			: `**Issue:** #${issueNum}`,
	);
	lines.push(`Closes #${issueNum}`);

	// PR creation status
	if (prCreationResult) {
		if (prCreationResult.success) {
			const action = prCreationResult.wasUpdate ? "updated" : "created";
			const prLink =
				prCreationResult.prNumber && config
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

	// Package safety summary — non-blocking informational section
	if (packageSafetyResult && packageSafetyResult.results.length > 0) {
		const blocked = packageSafetyResult.results.filter((r) => r.blocked);
		lines.push("");
		if (blocked.length > 0) {
			lines.push(
				`**Package safety:** ${packageSafetyResult.results.length} checked, ${blocked.length} blocked — see auditor review`,
			);
		} else if (packageSafetyResult.status === "error") {
			lines.push(`**Package safety:** error — ${packageSafetyResult.message || "check failed"}`);
		} else {
			lines.push(`**Package safety:** ${packageSafetyResult.results.length} checked, all safe`);
		}
	}

	// Failure info
	if (overallStatus === "failed") {
		const failedAgent = [...agentResults].reverse().find((a) => a.status === "FAILED");
		if (failedAgent) {
			lines.push("");
			lines.push(`**Stopped at:** ${failedAgent.agentName} — agent failed`);
		}
		if (errorMsg !== undefined && errorMsg !== "") {
			const truncated = errorMsg.length > 80 ? errorMsg.slice(0, 80) + "..." : errorMsg;
			lines.push("");
			lines.push(`**Error:** ${truncated}`);
		}
		lines.push("**Manual intervention required.**");
	}

	return lines.join("\n");
}
