// ─── Pipeline Stages — auditor output dispatch ───────────────────
// Auditor-specific comment building and posting: gate-rejection
// short-circuit, structured-vs-text-marker fallback, approval/
// rejection comment construction.
// Note: empty `catch {}` blocks around postIssueComment in the
// text-marker fallback are preserved verbatim (separate audit concern).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, AgentRunResult, AgentOutput } from "../../config/types.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { GitHubPort } from "../../github/ports.ts";
import {
	parseAgentOutput,
	isSuccess as isAgentOutputSuccess,
	extractStructuredAuditOutput,
} from "../../agent/output.ts";
import type { GateRejected } from "./core.ts";

export async function handleAuditorOutput(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentOutput: string,
	result: AgentRunResult,
	issueNum: number,
	config: SupervisorConfig,
	collector?: ErrorCollector,
	gateRejected?: GateRejected,
	port?: GitHubPort,
): Promise<void> {
	// If gate rejected, post gate-specific rejection comment and skip normal processing
	if (gateRejected) {
		const gateBody = buildGateRejectionComment(gateRejected);
		if (gateBody) {
			try {
				if (port) await port.postIssueComment(issueNum, config.repo, gateBody);
				ctx.ui.notify(
					`Audit score gate rejected: ${gateRejected.score.passing}/${gateRejected.total} < ${gateRejected.required}/${gateRejected.total}`,
					"warning",
				);
			} catch (grErr: unknown) {}
		}
		return;
	}

	const toolNamesSet = new Set(result.toolCalls ?? []);

	// Try structured AgentOutput parsing first
	const parseResult = parseAgentOutput(agentOutput, toolNamesSet);
	let actionFromOutput: "APPROVED" | "REJECTED" | undefined;
	let commentBodyFromOutput: string | undefined;

	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		if (output.action === "APPROVED" || output.action === "REJECTED") {
			actionFromOutput = output.action;
			commentBodyFromOutput = output.commentBody;
		} else if (output.action === "COMPLETE") {
			// Map COMPLETE to APPROVED/REJECTED based on findings.
			if (output.findings && output.findings.length > 0) {
				const hasBlockers = output.findings.some(
					(f) => f.severity === "critical" || f.severity === "warning",
				);
				actionFromOutput = hasBlockers ? "REJECTED" : "APPROVED";
			} else {
				actionFromOutput = "APPROVED";
			}
			commentBodyFromOutput = output.commentBody;
		}
	}

	// Fallback to old text-marker-based extraction
	if (!actionFromOutput) {
		await handleAuditorOutputFallback(pi, ctx, agentOutput, toolNamesSet, issueNum, config, port);
		return;
	}

	// Structured path: build comment from AgentOutput
	if (actionFromOutput === "APPROVED") {
		const bodyToPost =
			commentBodyFromOutput || buildApprovalCommentFromOutput(agentOutput, toolNamesSet);
		if (bodyToPost) {
			try {
				if (port) await port.postIssueComment(issueNum, config.repo, bodyToPost);
				ctx.ui.notify("Audit approval comment posted (from structured output)", "info");
			} catch (acErr: unknown) {
				collector?.push(
					"stages",
					"warn",
					`Failed to post audit comment: ${acErr instanceof Error ? acErr.message : String(acErr)}`,
				);
			}
		}
	} else if (actionFromOutput === "REJECTED") {
		const bodyToPost =
			commentBodyFromOutput || buildRejectionCommentFromOutput(agentOutput, toolNamesSet);
		if (bodyToPost) {
			try {
				if (port) await port.postIssueComment(issueNum, config.repo, bodyToPost);
				ctx.ui.notify("Audit rejection comment posted (from structured output)", "info");
			} catch (rcErr: unknown) {
				collector?.push(
					"stages",
					"warn",
					`Failed to post rejection comment: ${
						rcErr instanceof Error ? rcErr.message : String(rcErr)
					}`,
				);
			}
		}
	}
}

/**
 * Shared audit comment builder — parameterised with title and footer
 * to avoid duplicating the entire audit score + findings rendering.
 */
function buildAuditComment(
	agentOutput: string,
	title: string,
	footer: string,
	toolNames?: Set<string>,
): string | null {
	const parseResult = parseAgentOutput(agentOutput, toolNames);
	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		const lines: string[] = [title, ""];

		if (output.auditScore) {
			const passing = output.auditScore.passing;
			const total = output.auditScore.total;
			lines.push(
				`**Score:** ${passing}/${total} — ${passing === total ? "All dimensions passing" : `${passing} of ${total} dimensions passing`}`,
			);
			lines.push("");
		}

		if (output.findings && output.findings.length > 0) {
			lines.push("### Findings");
			lines.push("");
			for (const finding of output.findings) {
				lines.push(`- **${finding.severity} — ${finding.dimension}**`);
				if (finding.symptom) lines.push(`  - Symptom: ${finding.symptom}`);
				if (finding.consequence) lines.push(`  - Consequence: ${finding.consequence}`);
				if (finding.remedy) lines.push(`  - Remedy: ${finding.remedy}`);
				if (finding.location) lines.push(`  - Location: ${finding.location}`);
			}
			lines.push("");
		}

		lines.push(footer);
		return lines.join("\n");
	}

	return null;
}

/**
 * Build an approval comment from AgentOutput fields when no explicit commentBody provided.
 */
export function buildApprovalCommentFromOutput(
	agentOutput: string,
	toolNames?: Set<string>,
): string | null {
	return buildAuditComment(
		agentOutput,
		"## Audit Approved",
		"Fix and resubmit if issues remain.",
		toolNames,
	);
}

/**
 * Build a rejection comment from AgentOutput fields when no explicit commentBody provided.
 */
export function buildRejectionCommentFromOutput(
	agentOutput: string,
	toolNames?: Set<string>,
): string | null {
	return buildAuditComment(
		agentOutput,
		"## Audit Rejected",
		"Fix the issues above and resubmit.",
		toolNames,
	);
}

/**
 * Build a gate rejection comment explaining that the audit score did not
 * meet the configured threshold.
 */
function buildGateRejectionComment(gateRejected: GateRejected): string | null {
	const lines: string[] = [
		"## Audit Score Gate Rejected",
		"",
		`**Score:** ${gateRejected.score.passing}/${gateRejected.total} — requires at least ${gateRejected.required}/${gateRejected.total} (threshold: ${gateRejected.required}/${gateRejected.total})`,
		"",
		"The audit score gate determines whether the audit passes based on the structured findings. " +
			"The auditor's findings did not cover enough quality dimensions to meet the threshold.",
		"",
		"### How to fix",
		"",
		"- Review the audit findings below for specific issues",
		"- Address all 🔴 Critical and 🟡 Warning findings",
		"- Ensure findings span multiple quality dimensions (architecture-compliance, ticket-fulfillment, test-quality, correctness-safety, code-quality, completeness, duplicate-code, research-incorporation)",
		"- The score is computed from CRITICAL and WARNING findings only — suggestions do not affect the score",
		"",
		"Returning to Implementation for fixes.",
	];
	return lines.join("\n");
}

/**
 * Text-marker fallback path for auditor output: `extractStructuredAuditOutput`
 * markers, then bare-text `Approved`/`Rejected` wrap as a last resort.
 * Empty `catch {}` blocks around postIssueComment are preserved verbatim —
 * port failures here are swallowed silently, matching pre-split behavior.
 */
async function handleAuditorOutputFallback(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentOutput: string,
	toolNamesSet: Set<string>,
	issueNum: number,
	config: SupervisorConfig,
	port: GitHubPort | undefined,
): Promise<void> {
	const auditOutput = extractStructuredAuditOutput(agentOutput, toolNamesSet);

	if (!auditOutput) {
		const trimmed = agentOutput.trim();
		const approvedMatch = /^Approved[^a-zA-Z]/.test(trimmed) || /\bApproved\b/i.test(trimmed);
		const rejectedMatch = /^Rejected[^a-zA-Z]/.test(trimmed) || /\bRejected\b/i.test(trimmed);

		if (approvedMatch && !rejectedMatch) {
			try {
				const body = `## Audit Approved\n\n${trimmed.slice(0, 2000)}`;
				if (port) await port.postIssueComment(issueNum, config.repo, body);
				ctx.ui.notify("Audit approval comment posted (bare text fallback)", "info");
			} catch (acErr: unknown) {}
		} else if (rejectedMatch) {
			try {
				const body = `## Audit Rejected\n\n${trimmed.slice(0, 2000)}`;
				if (port) await port.postIssueComment(issueNum, config.repo, body);
				ctx.ui.notify("Audit rejection comment posted (bare text fallback)", "info");
			} catch (rcErr: unknown) {}
		}
		return;
	}

	if (auditOutput.decision === "APPROVED") {
		const bodyToPost =
			auditOutput.commentBody || buildApprovalCommentFromOutput(agentOutput, toolNamesSet);
		if (bodyToPost) {
			try {
				if (port) await port.postIssueComment(issueNum, config.repo, bodyToPost);
				ctx.ui.notify("Audit comment posted (text marker fallback)", "info");
			} catch (acErr: unknown) {}
		}
	} else if (auditOutput.decision === "REJECTED") {
		const bodyToPost =
			auditOutput.commentBody || buildRejectionCommentFromOutput(agentOutput, toolNamesSet);
		if (bodyToPost) {
			try {
				if (port) await port.postIssueComment(issueNum, config.repo, bodyToPost);
				ctx.ui.notify("Audit rejection comment posted (text marker fallback)", "info");
			} catch (rcErr: unknown) {}
		}
	}
}
