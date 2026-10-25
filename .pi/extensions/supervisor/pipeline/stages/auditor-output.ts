// ─── Pipeline Stages — auditor output dispatch ───────────────────
// Auditor-specific comment building and posting: gate-rejection
// short-circuit, structured-vs-text-marker fallback, approval/
// rejection comment construction. Rejections upsert the auditor's prior
// rejection in place (issue #2044); post failures surface via the collector.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	AgentRunResult,
	AgentOutput,
	FilteredIssueData,
} from "../../config/types.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { GitHubPort } from "../../github/ports.ts";
import { AUDIT_GATE_REJECTED_HEADING } from "../../lib/audit-headings.ts";
import { postApprovalComment, postOrUpdateAuditRejection } from "./audit-rejection-ops.ts";
import {
	parseAgentOutput,
	isSuccess as isAgentOutputSuccess,
	extractStructuredAuditOutput,
} from "../../agent/output.ts";
import {
	computeAuditScoreFromFindings,
	getActiveAuditDimensions,
	evaluateAuditScoreGate,
} from "../../config/workflow.ts";
import type { StageState, GateRejected } from "./core.ts";

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
	loopFilteredData?: FilteredIssueData,
): Promise<void> {
	// If gate rejected, upsert the gate-specific rejection comment and skip normal processing
	if (gateRejected) {
		const gateBody = buildGateRejectionComment(gateRejected);
		if (gateBody) {
			await postOrUpdateAuditRejection(
				issueNum,
				config,
				gateBody,
				loopFilteredData,
				collector,
				port,
				ctx,
			);
			ctx.ui.notify(
				`Audit score gate rejected: ${gateRejected.score.passing}/${gateRejected.total} < ${gateRejected.required}/${gateRejected.total}`,
				"warning",
			);
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
		await handleAuditorOutputFallback(
			pi,
			ctx,
			agentOutput,
			toolNamesSet,
			issueNum,
			config,
			collector,
			port,
			loopFilteredData,
		);
		return;
	}

	// Structured path: post the resolved verdict
	await handleStructuredVerdict(
		actionFromOutput,
		commentBodyFromOutput,
		agentOutput,
		toolNamesSet,
		issueNum,
		config,
		collector,
		port,
		loopFilteredData,
		ctx,
	);
}

/** Post the structured auditor verdict — approval as-is, rejection upserted. */
async function handleStructuredVerdict(
	action: "APPROVED" | "REJECTED",
	commentBody: string | undefined,
	agentOutput: string,
	toolNamesSet: Set<string>,
	issueNum: number,
	config: SupervisorConfig,
	collector: ErrorCollector | undefined,
	port: GitHubPort | undefined,
	loopFilteredData: FilteredIssueData | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const bodyToPost =
		commentBody ||
		(action === "APPROVED"
			? buildApprovalCommentFromOutput(agentOutput, toolNamesSet)
			: buildRejectionCommentFromOutput(agentOutput, toolNamesSet));
	if (!bodyToPost) return;
	if (action === "APPROVED") {
		await postApprovalComment(
			bodyToPost,
			"Audit approval comment posted (from structured output)",
			issueNum,
			config,
			collector,
			port,
			loopFilteredData,
			ctx,
		);
	} else {
		await postOrUpdateAuditRejection(
			issueNum,
			config,
			bodyToPost,
			loopFilteredData,
			collector,
			port,
			ctx,
		);
	}
}

/**
 * Pre-compute the audit score gate decision for an auditor result.
 * Runs BEFORE handlePostAgentSuccess so the gate-rejection comment can
 * replace the normal approval comment (extracted from runAgentLoop,
 * S104/S138 ceiling, issue #1533). Sync — no I/O; the warning notify
 * fires iff the gate rejects.
 */
export function computeAuditGateRejection(
	agentName: string,
	result: AgentRunResult,
	config: SupervisorConfig,
	stageState: StageState,
	ctx: ExtensionCommandContext,
): GateRejected | undefined {
	if (agentName !== "auditor" || !result.success || !result.textOutput) {
		return undefined;
	}
	const parseResult = parseAgentOutput(result.textOutput, new Set(result.toolCalls ?? []));
	if (!isAgentOutputSuccess(parseResult)) {
		return undefined;
	}
	const output = parseResult as AgentOutput;
	if (output.action !== "APPROVED" || !output.findings || output.findings.length === 0) {
		return undefined;
	}
	const dimensions = getActiveAuditDimensions(stageState.researcherSkipped);
	const score = computeAuditScoreFromFindings(output.findings, dimensions);
	const gateResult = evaluateAuditScoreGate(score, config.auditScoreThreshold ?? 0.75);
	if (gateResult.passes) {
		return undefined;
	}
	ctx.ui.notify(
		`Audit score gate rejected: ${score.passing}/${dimensions.length} < ${gateResult.required}/${dimensions.length}`,
		"warning",
	);
	return {
		score,
		required: gateResult.required,
		total: dimensions.length,
	};
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
		AUDIT_GATE_REJECTED_HEADING,
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
 * Rejections route through postOrUpdateAuditRejection; post failures surface
 * via the collector instead of being swallowed.
 */
async function handleAuditorOutputFallback(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentOutput: string,
	toolNamesSet: Set<string>,
	issueNum: number,
	config: SupervisorConfig,
	collector?: ErrorCollector,
	port?: GitHubPort,
	loopFilteredData?: FilteredIssueData,
): Promise<void> {
	const auditOutput = extractStructuredAuditOutput(agentOutput, toolNamesSet);

	if (!auditOutput) {
		const trimmed = agentOutput.trim();
		const approvedMatch = /^Approved[^a-zA-Z]/.test(trimmed) || /\bApproved\b/i.test(trimmed);
		const rejectedMatch = /^Rejected[^a-zA-Z]/.test(trimmed) || /\bRejected\b/i.test(trimmed);

		if (approvedMatch && !rejectedMatch) {
			await postApprovalComment(
				`## Audit Approved\n\n${trimmed.slice(0, 2000)}`,
				"Audit approval comment posted (bare text fallback)",
				issueNum,
				config,
				collector,
				port,
				loopFilteredData,
				ctx,
			);
		} else if (rejectedMatch) {
			await postOrUpdateAuditRejection(
				issueNum,
				config,
				`## Audit Rejected\n\n${trimmed.slice(0, 2000)}`,
				loopFilteredData,
				collector,
				port,
				ctx,
			);
		}
		return;
	}

	if (auditOutput.decision === "APPROVED") {
		const bodyToPost =
			auditOutput.commentBody || buildApprovalCommentFromOutput(agentOutput, toolNamesSet);
		if (bodyToPost) {
			await postApprovalComment(
				bodyToPost,
				"Audit comment posted (text marker fallback)",
				issueNum,
				config,
				collector,
				port,
				loopFilteredData,
				ctx,
			);
		}
	} else if (auditOutput.decision === "REJECTED") {
		const bodyToPost =
			auditOutput.commentBody || buildRejectionCommentFromOutput(agentOutput, toolNamesSet);
		if (bodyToPost) {
			await postOrUpdateAuditRejection(
				issueNum,
				config,
				bodyToPost,
				loopFilteredData,
				collector,
				port,
				ctx,
			);
		}
	}
}
