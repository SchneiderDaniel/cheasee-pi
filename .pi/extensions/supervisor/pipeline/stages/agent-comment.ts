// ─── Pipeline Stages — agent comment extraction + posting ────────
// LLM-output → GitHub-comment posting policy for architect,
// test-designer, and researcher: extraction fallback chain, heading
// rules, broken-fence cleanup, budget header, graceful degradation.
// Depends only on agent/output.ts and the port — no git, no workflow.
//
// Control flow is preserved verbatim from the pre-split stages.ts:
//   textOnly → textOutput → thinkingOutput → bare-text fallbacks,
//   the HEADING_RULES inject-vs-skip table, and the single combined
//   budget-exceeded comment are all load-bearing.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, AgentRunResult } from "../../config/types.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { GitHubPort } from "../../github/ports.ts";
import {
	extractAgentCommentBody,
	parseAgentOutput,
	isSuccess as isAgentOutputSuccess,
} from "../../agent/output.ts";
import { validateResearcherFindings } from "./core.ts";

// Bare-text fallback rules: maps agent names to the heading and regexes
// used when the agent output contains no JSON or structured heading.
type BareTextRule = {
	agent: string;
	heading: string;
	prefix: RegExp;
	word: RegExp;
};
const BARE_TEXT_RULES: readonly BareTextRule[] = [
	{
		agent: "architect",
		heading: "## Architecture",
		prefix: /^Architecture[^a-zA-Z]/,
		word: /\bArchitecture\b/i,
	},
	{
		agent: "test-designer",
		heading: "## Test Plan",
		prefix: /^Test\s*Plan[^a-zA-Z]/,
		word: /\bTest\s*Plan\b/i,
	},
	{
		agent: "researcher",
		heading: "## Research Findings",
		prefix: /^Research[^a-zA-Z]/,
		word: /\bResearch\b/i,
	},
];

/**
 * Extract the agent comment body from the run result.
 * Fallback chain: textOnly → textOutput → thinkingOutput → bare text.
 * Returns the body plus the source label used in warnings.
 */
function extractCommentBody(
	result: AgentRunResult,
	agentName: string,
	collector?: ErrorCollector,
): { commentBody: string | null; extractionSource: string } {
	// Try multiple sources. textOnly is clean LLM text (no tool/thinking noise).
	// textOutput / output fallbacks handle cases where JSON lived in streaming
	// deltas not captured by textOutputLines (rare).
	let commentBody: string | null = null;
	let extractionSource = "";

	// Primary: textOnly — clean text output from the LLM (no tool/thinking noise).
	// This is the expected path for all models. The agent's JSON structured output
	// is at the end of the text response. textOnly avoids capturing tool call
	// results, thinking blocks, system prompt echoes, and context info that would
	// bleed into the section heading extraction fallback.
	const toolNamesSet = new Set(result.toolCalls ?? []);
	if (result.textOnly) {
		commentBody = extractAgentCommentBody(result.textOnly, toolNamesSet);
		if (commentBody) {
			extractionSource = "result.textOnly";
		}
	}

	// Fallback 1: textOutput (full instrumented log) — contains JSON from deltas
	// when textOnly is empty (edge case: non-streaming or subprocess-only agents).
	if (!commentBody && result.textOutput) {
		commentBody = extractAgentCommentBody(result.textOutput, toolNamesSet);
		if (commentBody) {
			extractionSource = "result.textOutput";
			collector?.push(
				"stages",
				"warn",
				`${agentName} commentBody extracted from result.textOutput (fallback after textOnly)`,
			);
		}
	}

	// Fallback 2: thinkingOutput — models with thinking:high may emit
	// JSON in thinking blocks which land in thinkingOutputLines.
	//
	// NOTE: result.output (raw subprocess stdout) is intentionally omitted
	// from this fallback chain. Raw stdout contains pi internal protocol
	// (NDJSON events, agent_end with full conversation dump, model metadata)
	// and using it as a comment source leaks system prompts, tool results,
	// and token usage to GitHub issues. textOnly → textOutput → thinkingOutput
	// covers all agent output formats without touching raw subprocess output.
	// The pipeline ran ~1000 issues without result.output before the
	// session-dump event existed.
	if (!commentBody && result.thinkingOutput) {
		commentBody = extractAgentCommentBody(result.thinkingOutput, toolNamesSet);
		if (commentBody) {
			extractionSource = "result.thinkingOutput";
			collector?.push(
				"stages",
				"warn",
				`${agentName} commentBody extracted from result.thinkingOutput (fallback)`,
			);
		}
	}

	// Tertiary fallback: bare text detection for architect, test-designer, researcher.
	// When agent omits JSON and section headings, detect role-relevant content
	// and wrap in default heading so review is not silently lost.
	if (!commentBody) {
		const rawOutput = result.textOutput || result.output || "";
		let wrapped: string | null = null;

		const rule = BARE_TEXT_RULES.find((r) => r.agent === agentName);
		if (rule && (rule.prefix.test(rawOutput) || rule.word.test(rawOutput))) {
			wrapped = `${rule.heading}\n\n${rawOutput.trim().slice(0, 2000)}`;
		}

		if (wrapped) {
			commentBody = wrapped;
			extractionSource = "bare-text-fallback";
			collector?.push(
				"stages",
				"warn",
				`${agentName} commentBody extracted from bare text fallback (no JSON or heading found)`,
			);
		}
	}

	return { commentBody, extractionSource };
}

/**
 * Post-process a comment body: researcher empty-findings validation,
 * required-heading inject/skip, trailing broken ```json fence strip,
 * and budget-exceeded "stopped early" header.
 * Returns the final body, or null when the comment should not be posted.
 */
function validateAndInjectHeading(
	commentBody: string | null,
	agentName: string,
	result: AgentRunResult,
	extractionSource: string,
	collector?: ErrorCollector,
): string | null {
	// Validate researcher output: if commentBody is just empty headers with no
	// actual findings (e.g. "### Best Practices\n- —"), replace with fallback.
	if (commentBody && agentName === "researcher") {
		const validated = validateResearcherFindings(commentBody);
		if (validated !== commentBody) {
			collector?.push(
				"stages",
				"warn",
				`researcher commentBody has no substantive findings (source: ${extractionSource}). Replacing with graceful degradation message.`,
			);
			commentBody = validated;
		}
	}

	// Validate agent output must contain the expected heading.
	// Table-driven dispatch replaces per-role if blocks that drifted apart.
	// Each entry defines the required heading and the action to take when
	// it's missing: "inject" (prepend the heading and post) or "skip"
	// (null out commentBody, letting the graceful degradation path handle it).
	const HEADING_RULES: Record<string, { heading: string; onMissing: "inject" | "skip" }> = {
		"test-designer": { heading: "## Test Plan", onMissing: "inject" },
		architect: { heading: "## Architecture", onMissing: "inject" },
		researcher: { heading: "## Research Findings", onMissing: "skip" },
	};
	const rule = HEADING_RULES[agentName];
	if (commentBody && rule && !commentBody.includes(rule.heading)) {
		if (rule.onMissing === "inject") {
			collector?.push(
				"stages",
				"warn",
				`${agentName} commentBody missing "${rule.heading}" heading. ` +
					`Injecting heading. commentBody starts with: ${JSON.stringify(commentBody.slice(0, 80))}. ` +
					`Source: ${extractionSource}`,
			);
			commentBody = `${rule.heading}\n\n${commentBody}`;
		} else {
			collector?.push(
				"stages",
				"warn",
				`${agentName} commentBody missing "${rule.heading}" heading. ` +
					`commentBody starts with: ${JSON.stringify(commentBody.slice(0, 80))}. ` +
					`Skipping post. Source: ${extractionSource}`,
			);
			commentBody = null;
		}
	}

	// Defense-in-depth: strip trailing broken ```json code fences from any agent comment.
	// If the heading extraction (Fallback 2 in extractAgentCommentBody) fails to strip
	// the agent's structured JSON block — either truncated mid-JSON or complete — the
	// raw code fence leaks into the posted comment. This catch-all strips any trailing
	// ```json fence still present after extraction.
	if (commentBody) {
		const lastBacktickFence = commentBody.lastIndexOf("\n```json");
		if (lastBacktickFence !== -1) {
			// Check if the fence is at the end of the content (no substantive text after it)
			const afterFence = commentBody.slice(lastBacktickFence + 1).trim();
			// Strip if the fence contains only JSON (not legitimate code examples in comment)
			const trimmed = commentBody.slice(0, lastBacktickFence).trim();
			if (trimmed.length >= 50) {
				commentBody = trimmed;
			} else {
				// After stripping fence, content too short — comment is just broken JSON wrapper
				collector?.push(
					"stages",
					"warn",
					`${agentName} commentBody is only a broken \`\`\`json fence — skipping post. ` +
						`commentBody starts with: ${JSON.stringify(commentBody.slice(0, 80))}`,
				);
				commentBody = null;
			}
		}
	}

	// When researcher budget was exceeded, compose a single combined comment
	// with "stopped early" header + partial findings, so the budget-exceeded
	// handler in handler.ts can skip its own separate comment (no duplication).
	// The existing heading is replaced to avoid redundant headings.
	if (commentBody && agentName === "researcher" && result.budgetExceeded) {
		const budgetHeader = `## Research Findings — Research stopped early: agent exceeded token budget (${result.tokenCount} tokens used). Pipeline continues without full research findings.`;
		const firstNewline = commentBody.indexOf("\n");
		if (firstNewline !== -1) {
			commentBody = budgetHeader + commentBody.slice(firstNewline);
		} else {
			commentBody = budgetHeader;
		}
	}

	return commentBody;
}

/**
 * Post the final comment body, or fall back to graceful degradation
 * when no body survived processing. Comment-post failures never return
 * false — the pipeline continues (advisory invariant).
 */
async function postCommentOrFallback(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	result: AgentRunResult,
	agentName: string,
	issueNum: number,
	config: SupervisorConfig,
	commentBody: string | null,
	extractionSource: string,
	collector: ErrorCollector | undefined,
	port: GitHubPort | undefined,
): Promise<void> {
	if (commentBody) {
		try {
			if (port) await port.postIssueComment(issueNum, config.repo, commentBody);
			ctx.ui.notify(`Posted ${agentName} comment on issue #${issueNum}`, "info");
		} catch (commentErr: unknown) {
			collector?.push(
				"stages",
				"warn",
				`Failed to post ${agentName} comment: ${
					commentErr instanceof Error ? commentErr.message : String(commentErr)
				}`,
			);
		}
	} else {
		// Graceful degradation: researcher with no commentBody still
		// posts a "no findings" comment so issue has visible researcher output.
		// Prevents silent skip when LLM treats commentBody as optional and omits it.
		if (agentName === "researcher") {
			const fallbackComment = "## Research Findings — No relevant results found for this topic.";

			// Check if researcher output had valid structured JSON (even without commentBody).
			// If so, null commentBody was intentional — researcher decided "nothing to research."
			// Only warn if NO valid JSON output was produced at all (crash/parse failure).
			const researcherOutput = result.textOutput || result.output || "";
			const parseResult = parseAgentOutput(researcherOutput, new Set(result.toolCalls ?? []));
			const hadValidStructuredOutput = isAgentOutputSuccess(parseResult);

			if (!hadValidStructuredOutput) {
				collector?.push(
					"stages",
					"warn",
					`${agentName} completed but no commentBody in JSON output. ` +
						`Posting graceful degradation comment. ` +
						`textOutput: ${JSON.stringify((result.textOutput || "").slice(0, 200))}, ` +
						`output: ${JSON.stringify((result.output || "").slice(0, 200))}`,
				);
			}
			try {
				if (port) await port.postIssueComment(issueNum, config.repo, fallbackComment);
				ctx.ui.notify(
					`Posted ${agentName} comment (graceful degradation) on issue #${issueNum}`,
					"info",
				);
			} catch (commentErr: unknown) {
				collector?.push(
					"stages",
					"warn",
					`Failed to post ${agentName} graceful degradation comment: ${
						commentErr instanceof Error ? commentErr.message : String(commentErr)
					}`,
				);
			}
		} else {
			collector?.push(
				"stages",
				"warn",
				`${agentName} completed but no commentBody found. ` +
					`textOutput: ${JSON.stringify((result.textOutput || "").slice(0, 200))}, ` +
					`output: ${JSON.stringify((result.output || "").slice(0, 200))}`,
			);
		}
	}
}

/**
 * Handle post-agent-success comment side effects for architect,
 * test-designer, and researcher: extract → validate/inject heading →
 * post (or graceful degradation).
 */
export async function handleAgentComment(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	result: AgentRunResult,
	agentName: string,
	issueNum: number,
	config: SupervisorConfig,
	collector?: ErrorCollector,
	port?: GitHubPort,
): Promise<void> {
	const { commentBody, extractionSource } = extractCommentBody(result, agentName, collector);
	const finalBody = validateAndInjectHeading(
		commentBody,
		agentName,
		result,
		extractionSource,
		collector,
	);
	await postCommentOrFallback(
		pi,
		ctx,
		result,
		agentName,
		issueNum,
		config,
		finalBody,
		extractionSource,
		collector,
		port,
	);
}
