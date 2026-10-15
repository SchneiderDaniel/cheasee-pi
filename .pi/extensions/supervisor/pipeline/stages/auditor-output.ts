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
import {
	countAuditRejections,
	findPriorAuditRejection,
	rejectLabel,
} from "../../lib/audit-rejections.ts";
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
 * Post or update the supervisor's audit rejection (issue #2044).
 *
 * The `reject-N` label is the durable loop counter for the in-place update
 * path, so it is written first and rolled back if the comment write fails.
 * When the label cannot be written the rejection is appended instead — the
 * legacy comment count then keeps the counter advancing, so a label outage
 * degrades to the old append behaviour instead of stalling the loop or
 * aborting the pipeline.
 *
 * Superseded rejection comments (older ones on an issue rejected before this
 * feature) are deleted only while the label counter is authoritative;
 * otherwise they are exactly what keeps the comment-count fallback growing.
 */
async function postOrUpdateAuditRejection(
	issueNum: number,
	config: SupervisorConfig,
	body: string,
	loopFilteredData: FilteredIssueData | undefined,
	collector: ErrorCollector | undefined,
	port: GitHubPort | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!port) {
		collector?.push("stages", "error", "Cannot record audit rejection: GitHub port unavailable");
		return;
	}
	const rejections = loopFilteredData?.auditRejections ?? [];
	const prior = findPriorAuditRejection(rejections);

	// Resolve the counter before writing so a label outage can fall back to a
	// new comment (which grows the legacy count) instead of aborting.
	let labels: string[] | undefined;
	try {
		labels = await port.getIssueLabels(issueNum, config.repo);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("stages", "warn", `Failed to read reject labels: ${msg}`);
	}
	const current = countAuditRejections(labels ?? [], loopFilteredData?.rejectionCommentCount ?? 0);
	const next = current + 1;

	// Label first: an in-place update keeps a single rejection comment, so the
	// label is the only durable record of the increment.
	let bumped = false;
	if (labels) {
		try {
			await port.addIssueLabel(issueNum, config.repo, rejectLabel(next));
			bumped = true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			collector?.push("stages", "warn", `Failed to record reject label: ${msg}`);
		}
	}

	const updateInPlace = !!prior && bumped;
	try {
		if (updateInPlace && prior) {
			await port.updateIssueComment(prior.id, config.repo, body);
			ctx.ui.notify("Audit rejection comment updated in place", "info");
		} else {
			await port.postIssueComment(issueNum, config.repo, body);
			ctx.ui.notify("Audit rejection comment posted", "info");
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const action = updateInPlace ? "update" : "post";
		collector?.push("stages", "error", `Failed to ${action} audit rejection: ${msg}`);
		ctx.ui.notify(`Audit rejection could not be saved: ${msg}`, "error");
		// Roll back the counter bump — the rejection was not persisted, so the
		// loop must not advance — then fail closed: the next implementation run
		// would otherwise have no feedback.
		if (bumped) {
			try {
				await port.removeIssueLabel(issueNum, config.repo, rejectLabel(next));
			} catch (rollbackErr: unknown) {
				const rollbackMsg =
					rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
				collector?.push("stages", "warn", `Failed to roll back reject label: ${rollbackMsg}`);
			}
		}
		throw new Error(`Failed to ${action} audit rejection: ${msg}`);
	}

	if (!bumped) return;
	// The label now carries the count, so stale rejections can be removed.
	await deleteSupersededRejections(
		port,
		config.repo,
		rejections,
		updateInPlace ? prior?.id : undefined,
		collector,
	);
	if (current > 0) {
		try {
			await port.removeIssueLabel(issueNum, config.repo, rejectLabel(current));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			collector?.push("stages", "warn", `Failed to remove stale reject label: ${msg}`);
		}
	}
}

/**
 * Delete every supervisor rejection comment except `keepId` (issue #2044):
 * older issues accumulated one rejection comment per loop, and the in-place
 * update only collapses the newest. Best effort — a failed delete must not
 * block the audit transition.
 */
async function deleteSupersededRejections(
	port: GitHubPort,
	repo: string,
	rejections: Array<{ id?: string }>,
	keepId: string | undefined,
	collector: ErrorCollector | undefined,
): Promise<void> {
	for (const rejection of rejections) {
		if (rejection.id && rejection.id !== keepId) {
			try {
				await port.deleteIssueComment(rejection.id, repo);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				collector?.push(
					"stages",
					"warn",
					`Failed to delete superseded rejection ${rejection.id}: ${msg}`,
				);
			}
		}
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

/**
 * Post an approval comment, retiring any supervisor rejection it supersedes:
 * an approved issue must not keep advertising a rejection the audit cleared
 * (issue #2044).
 */
async function postApprovalComment(
	body: string,
	notifyMessage: string,
	issueNum: number,
	config: SupervisorConfig,
	collector: ErrorCollector | undefined,
	port: GitHubPort | undefined,
	loopFilteredData: FilteredIssueData | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!port) return;
	try {
		await port.postIssueComment(issueNum, config.repo, body);
		ctx.ui.notify(notifyMessage, "info");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("stages", "warn", `Failed to post audit approval comment: ${msg}`);
		return;
	}
	await deleteSupersededRejections(
		port,
		config.repo,
		loopFilteredData?.auditRejections ?? [],
		undefined,
		collector,
	);
}
