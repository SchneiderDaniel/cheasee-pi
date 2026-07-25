// ─── Pipeline Notifications ──────────────────────────────────────
// Status notifications, pipeline completion summary, bell.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	PipelineAgentResult,
	AgentRunState,
	PrCreationResult,
} from "../config/types.ts";
import { formatDuration } from "../lib/formatting.ts";
import { buildPipelineSummary } from "../pipeline/output.ts";
import type { ErrorCollector } from "./error-collector.ts";
import type { PackageSafetyAuditResult } from "../checks/package-safety.ts";

// ─── Agent Progress Streaming (removed) ──────────────────────────
// Previously: sendAgentProgressMessage/clearAgentProgressMessage sent invisible
// pi.sendMessage({ customType: "supervisor-progress", display: false }) messages.
// Replaced by ctx.ui.setWidget() in executeSubagent() for live widget-based progress.
// The widget approach shows live tool calls, thinking, and text above the editor
// without scrolling the chat history. Final result message uses eventType: "subagent-result" format.

/**
 * Send pipeline completion notification.
 * Builds summary markdown and sends as supervisor-summary message.
 * Accepts optional PrCreationResult to adjust completion message.
 * Accepts optional gateFailureHistory for PR body gate failure context (R2).
 */
export function sendPipelineSummary(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentResults: PipelineAgentResult[],
	overallStatus: "success" | "failed" | "stopped",
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	stopReason?: string,
	prCreationResult?: PrCreationResult,
	collector?: ErrorCollector,
	gateFailureHistory?: string[],
	packageSafetyResult?: PackageSafetyAuditResult | null,
	unresolvedConflicts?: boolean,
): void {
	// Prepend warnings block from collector if non-empty
	const warningsBlock = collector?.toNotificationBlock();
	const summaryMarkdown = buildPipelineSummary(
		agentResults,
		overallStatus,
		issueNum,
		issueTitle,
		config,
		overallStatus === "stopped" ? stopReason : undefined,
		prCreationResult,
		gateFailureHistory,
		packageSafetyResult,
	);

	// Combine warnings and summary
	let finalContent = warningsBlock ? warningsBlock + "\n\n" + summaryMarkdown : summaryMarkdown;
	if (unresolvedConflicts) {
		finalContent =
			`⚠️ **Merge conflicts remain in PR #${issueNum}.** Worktree preserved for manual resolution.\n\n` +
			finalContent;
	}

	// If warnings exist, also send a separate supervisor-warnings message
	if (warningsBlock) {
		pi.sendMessage({
			customType: "supervisor-warnings",
			content: warningsBlock,
			display: true,
		});
	}

	pi.sendMessage({
		customType: "supervisor-summary",
		content: finalContent,
		display: true,
	});

	// Adjust notification text for PR creation failure
	const isPrFailed = prCreationResult && !prCreationResult.success;
	const effectiveStatus = isPrFailed && overallStatus === "success" ? "pr-failed" : overallStatus;

	if (unresolvedConflicts) {
		ctx.ui.notify("Pipeline complete — merge conflicts remain.", "warning");
	} else if (effectiveStatus === "pr-failed") {
		ctx.ui.notify("Pipeline complete (PR creation failed).", "warning");
	} else if (effectiveStatus === "success") {
		ctx.ui.notify("Pipeline complete.", "info");
	} else if (effectiveStatus === "failed") {
		ctx.ui.notify("Pipeline failed.", "error");
	} else {
		ctx.ui.notify("Pipeline stopped.", "warning");
	}

	if (unresolvedConflicts) {
		const totalDurationMs = agentResults.reduce((sum, a) => sum + a.durationMs, 0);
		ctx.ui.setStatus(
			"supervisor",
			ctx.ui.theme.fg(
				"warning",
				`⚠️ Conflicts remain · ${agentResults.length} agents · ${formatDuration(totalDurationMs)}`,
			),
		);
	} else if (effectiveStatus === "success") {
		const totalDurationMs = agentResults.reduce((sum, a) => sum + a.durationMs, 0);
		ctx.ui.setStatus(
			"supervisor",
			ctx.ui.theme.fg(
				"success",
				`✅ Done · ${agentResults.length} agents · ${formatDuration(totalDurationMs)}`,
			),
		);
	} else if (effectiveStatus === "pr-failed") {
		const totalDurationMs = agentResults.reduce((sum, a) => sum + a.durationMs, 0);
		ctx.ui.setStatus(
			"supervisor",
			ctx.ui.theme.fg(
				"warning",
				`⚠️ Done (PR failed) · ${agentResults.length} agents · ${formatDuration(totalDurationMs)}`,
			),
		);
	} else if (effectiveStatus === "failed") {
		ctx.ui.setStatus("supervisor", ctx.ui.theme.fg("error", buildFailedStatusLine(agentResults)));
	} else {
		ctx.ui.setStatus(
			"supervisor",
			ctx.ui.theme.fg("warning", `⏹ Stopped: ${stopReason || "unknown reason"}`),
		);
	}

	if (config.bellOnComplete) {
		process.stdout.write("\x07");
	}
}

/**
 * Send error notification for pipeline failure.
 */
export function sendPipelineError(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentResults: PipelineAgentResult[],
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	msg: string,
	gateFailureHistory?: string[],
	packageSafetyResult?: PackageSafetyAuditResult | null,
): void {
	ctx.ui.notify(`Supervisor error: ${msg}`, "error");

	const overallStatus: "failed" = "failed";
	const summaryMarkdown = buildPipelineSummary(
		agentResults,
		overallStatus,
		issueNum,
		issueTitle,
		config,
		undefined,
		undefined,
		gateFailureHistory,
		packageSafetyResult,
		msg,
	);

	pi.sendMessage({
		customType: "supervisor-summary",
		content: summaryMarkdown,
		display: true,
	});

	if (agentResults.length > 0) {
		ctx.ui.setStatus("supervisor", ctx.ui.theme.fg("error", buildFailedStatusLine(agentResults)));
	}

	if (config?.bellOnComplete) {
		process.stdout.write("\x07");
	}
	// Always clear supervisor status on error — avoids stale error text in footer
	ctx.ui.setStatus("supervisor", undefined);
}

/**
 * Build the failed status line for pipeline error display.
 * Extracted to eliminate clone: used by both sendPipelineSummary and sendPipelineError.
 */
function buildFailedStatusLine(agentResults: PipelineAgentResult[]): string {
	const lastFailed = [...agentResults].reverse().find((a) => a.status === "FAILED");
	return `❌ Failed at ${lastFailed?.agentName || "unknown"} · ${agentResults.length} agents`;
}
