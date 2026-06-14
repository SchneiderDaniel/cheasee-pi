// ─── Pipeline Notifications ──────────────────────────────────────
// Status notifications, pipeline completion summary, bell.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	PipelineAgentResult,
	SupervisorMessageDetails,
	PrCreationResult,
} from "../config/types.ts";
import { formatDuration } from "../lib/formatting.ts";
import { buildPipelineSummary } from "../pipeline/output.ts";
import type { ErrorCollector } from "./error-collector.ts";

/**
 * Send pipeline completion notification.
 * Builds summary markdown and sends as supervisor-summary message.
 * Accepts optional PrCreationResult to adjust completion message.
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
	);

	// Combine warnings and summary
	const finalContent = warningsBlock ? warningsBlock + "\n\n" + summaryMarkdown : summaryMarkdown;

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

	if (effectiveStatus === "pr-failed") {
		ctx.ui.notify("Pipeline complete (PR creation failed).", "warning");
	} else if (effectiveStatus === "success") {
		ctx.ui.notify("Pipeline complete.", "info");
	} else if (effectiveStatus === "failed") {
		ctx.ui.notify("Pipeline failed.", "error");
	} else {
		ctx.ui.notify("Pipeline stopped.", "warning");
	}

	if (effectiveStatus === "success") {
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
		const lastFailed = [...agentResults].reverse().find((a) => a.status === "FAILED");
		ctx.ui.setStatus(
			"supervisor",
			ctx.ui.theme.fg(
				"error",
				`❌ Failed at ${lastFailed?.agentName || "unknown"} · ${agentResults.length} agents`,
			),
		);
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
 * Send an agent result message to the UI with details.
 */
export function sendAgentResultMessage(
	pi: ExtensionAPI,
	result: {
		agentName: string;
		success: boolean;
		summaryLine: string;
		statusLabel: string;
		toolCount: number;
		tokenCount: number;
		durationMs: number;
		textOutput: string;
		textOnly: string;
		output: string;
		thinkingOutput?: string;
	},
	auditScore?: string,
): void {
	pi.sendMessage({
		customType: "supervisor",
		content: `## Agent: ${result.agentName} — ${result.statusLabel}\n\n${result.summaryLine}`,
		display: true,
		details: {
			agentName: result.agentName,
			success: result.success,
			statusLabel: result.statusLabel,
			toolCount: result.toolCount,
			tokenCount: result.tokenCount,
			durationMs: result.durationMs,
			summaryLine: result.summaryLine,
			thinkingOutput: result.thinkingOutput,
			hasThinking: !!result.thinkingOutput,
			auditScore,
		} satisfies SupervisorMessageDetails,
	});
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
): void {
	ctx.ui.notify(`Supervisor error: ${msg}`, "error");

	if (agentResults.length > 0) {
		const overallStatus: "failed" = "failed";
		const summaryMarkdown = buildPipelineSummary(
			agentResults,
			overallStatus,
			issueNum,
			issueTitle,
			config,
		);

		pi.sendMessage({
			customType: "supervisor-summary",
			content: summaryMarkdown,
			display: true,
		});

		const lastFailed = [...agentResults].reverse().find((a) => a.status === "FAILED");
		ctx.ui.setStatus(
			"supervisor",
			ctx.ui.theme.fg(
				"error",
				`❌ Failed at ${lastFailed?.agentName || "unknown"} · ${agentResults.length} agents`,
			),
		);

		if (config?.bellOnComplete) {
			process.stdout.write("\x07");
		}
	}
	// Always clear supervisor status on error — avoids stale error text in footer
	ctx.ui.setStatus("supervisor", undefined);
}
