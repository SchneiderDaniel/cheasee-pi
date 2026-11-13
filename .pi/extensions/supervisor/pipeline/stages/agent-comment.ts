// ─── Pipeline Stages — agent comment extraction + posting ────────
// LLM-output → GitHub-comment posting policy for architect,
// test-designer, and researcher: extraction fallback chain, heading
// rules, broken-fence cleanup, budget header, graceful degradation.
// Depends only on agent/output.ts and the port — no git, no workflow.
//
// Control flow is preserved verbatim from the pre-split stages.ts:
//   textOnly → textOutput → thinkingOutput → bare-text fallbacks,
//   the ROLE_HEADINGS inject-vs-skip table, and the single combined
//   budget-exceeded comment are all load-bearing.
//
// Issue #2107 turned the two heading tables into one, made the source
// chain a data list, and collapsed the duplicated post try/catch into
// `postComment`. Public behaviour is pinned by
// `test/agent-comment-stage.test.mts`.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, AgentRunResult } from "../../config/types.ts";
import type { ErrorCollector } from "../error-collector.ts";
import type { GitHubPort } from "../../github/ports.ts";
import {
	extractAgentCommentBody,
	parseAgentOutput,
	isSuccess as isAgentOutputSuccess,
	isRefused,
} from "../../agent/output.ts";
import { validateResearcherFindings } from "./core.ts";

/** Comment body the researcher stage posts when it produced nothing usable. */
const RESEARCH_FALLBACK = "## Research Findings — No relevant results found for this topic.";

/**
 * Everything a role needs when its output carries no JSON and no heading:
 * the heading to require, what to do when it is missing, and the bare-text
 * shapes that wrap raw prose in that heading. One table, one owner — the
 * heading knowledge used to live in two.
 */
interface RoleHeading {
	/** The heading the posted comment must carry. */
	heading: string;
	/** Missing heading: `inject` prepends it, `skip` drops the body. */
	onMissing: "inject" | "skip";
	/** A bare-text prefix (`Architecture:`) that identifies the role's prose. */
	bareTextPrefix: RegExp;
	/** A bare-text word mention (`Architecture`) that identifies it. */
	bareTextWord: RegExp;
}

const ROLE_HEADINGS: Record<string, RoleHeading> = {
	architect: {
		heading: "## Architecture",
		onMissing: "inject",
		bareTextPrefix: /^Architecture[^a-zA-Z]/,
		bareTextWord: /\bArchitecture\b/i,
	},
	"test-designer": {
		heading: "## Test Plan",
		onMissing: "inject",
		bareTextPrefix: /^Test\s*Plan[^a-zA-Z]/,
		bareTextWord: /\bTest\s*Plan\b/i,
	},
	researcher: {
		heading: "## Research Findings",
		onMissing: "skip",
		bareTextPrefix: /^Research[^a-zA-Z]/,
		bareTextWord: /\bResearch\b/i,
	},
};

/** A comment source in fallback order; `warn` fires only on a fallback hit. */
interface CommentSource {
	/** The result field to read. */
	pick: (result: AgentRunResult) => string | undefined;
	/** Label used in warnings — part of the observable message text. */
	label: string;
	/** Suffix appended to the fallback warning, or null for the primary source. */
	warn: string | null;
}

// Fallback order. textOnly is clean LLM text (no tool/thinking noise); textOutput
// and thinkingOutput cover JSON that lived in streaming deltas the textOnly
// capture missed (rare).
//
// NOTE: `result.output` (raw subprocess stdout) is intentionally absent. Raw
// stdout contains pi internal protocol (NDJSON events, agent_end with the full
// conversation dump, model metadata), so using it as a comment source leaks
// system prompts, tool results, and token usage to GitHub issues. An empty model
// run must degrade, not post protocol junk (issue #1671: a 400 API error
// produced a 0-token run whose NDJSON dump was wrapped as "Research Findings").
const COMMENT_SOURCES: readonly CommentSource[] = [
	{ pick: (result) => result.textOnly, label: "result.textOnly", warn: null },
	{
		pick: (result) => result.textOutput,
		label: "result.textOutput",
		warn: "extracted from result.textOutput (fallback after textOnly)",
	},
	{
		pick: (result) => result.thinkingOutput,
		label: "result.thinkingOutput",
		warn: "extracted from result.thinkingOutput (fallback)",
	},
];

const EMPTY_BODY_PREVIEW = 80;

/** The side effects a comment post needs; `port` absent means notify-only. */
interface CommentPost {
	ctx: ExtensionCommandContext;
	port: GitHubPort | undefined;
	issueNum: number;
	repo: string;
	collector: ErrorCollector | undefined;
}

function warn(collector: ErrorCollector | undefined, message: string): void {
	collector?.push("stages", "warn", message);
}

/**
 * Extract the agent comment body from the run result: the structured sources in
 * `COMMENT_SOURCES` order, then the role's bare-text fallback.
 * Returns the body plus the source label used in warnings.
 */
function extractCommentBody(
	result: AgentRunResult,
	agentName: string,
	collector?: ErrorCollector,
): { commentBody: string | null; extractionSource: string } {
	const toolNames = new Set(result.toolCalls ?? []);

	for (const candidate of COMMENT_SOURCES) {
		const text = candidate.pick(result);
		const commentBody = text ? extractAgentCommentBody(text, toolNames) : null;
		if (!commentBody) continue;
		if (candidate.warn) warn(collector, `${agentName} commentBody ${candidate.warn}`);
		return { commentBody, extractionSource: candidate.label };
	}

	// Bare text: the agent omitted both JSON and its section heading. Detect
	// role-relevant prose and wrap it in the role heading, so a review is not
	// silently lost. Reads textOutput only — never raw `result.output`.
	const rawOutput = result.textOutput || "";
	const rule = ROLE_HEADINGS[agentName];
	const matched =
		rule && (rule.bareTextPrefix.test(rawOutput) || rule.bareTextWord.test(rawOutput));
	if (matched) {
		warn(
			collector,
			`${agentName} commentBody extracted from bare text fallback (no JSON or heading found)`,
		);
		return {
			commentBody: `${rule.heading}\n\n${rawOutput.trim().slice(0, 2000)}`,
			extractionSource: "bare-text-fallback",
		};
	}

	// Empty-run detection: success=true with 0 tokens, 0 tools and no text means
	// the model never produced output (e.g. a 400 API error swallowed with exit
	// code 0). Surface it so the run doesn't masquerade as a clean success in the
	// pipeline warnings (issue #1671).
	const isEmptyRun =
		result.tokenCount === 0 && result.toolCount === 0 && !result.textOnly && !result.textOutput;
	if (isEmptyRun) {
		warn(
			collector,
			`${agentName} produced no output (tokenCount=0, toolCount=0, empty text). ` +
				`Model/API error — no output comment posted.`,
		);
	}

	return { commentBody: null, extractionSource: "" };
}

/**
 * Validate researcher output: a body that is just empty headers with no actual
 * findings (e.g. "### Best Practices\n- —") degrades to the fallback message.
 */
function validateResearcherBody(
	commentBody: string,
	extractionSource: string,
	collector?: ErrorCollector,
): string {
	const validated = validateResearcherFindings(commentBody);
	if (validated === commentBody) return commentBody;
	warn(
		collector,
		`researcher commentBody has no substantive findings (source: ${extractionSource}). ` +
			`Replacing with graceful degradation message.`,
	);
	return validated;
}

/**
 * Require the role's heading. `inject` prepends it to a bare body; `skip` drops
 * the body so the graceful-degradation path owns the comment.
 */
function applyHeadingPolicy(
	commentBody: string,
	rule: RoleHeading,
	agentName: string,
	extractionSource: string,
	collector?: ErrorCollector,
): string | null {
	if (commentBody.includes(rule.heading)) return commentBody;
	const preview = JSON.stringify(commentBody.slice(0, EMPTY_BODY_PREVIEW));
	if (rule.onMissing === "skip") {
		warn(
			collector,
			`${agentName} commentBody missing "${rule.heading}" heading. ` +
				`commentBody starts with: ${preview}. ` +
				`Skipping post. Source: ${extractionSource}`,
		);
		return null;
	}
	warn(
		collector,
		`${agentName} commentBody missing "${rule.heading}" heading. ` +
			`Injecting heading. commentBody starts with: ${preview}. ` +
			`Source: ${extractionSource}`,
	);
	return `${rule.heading}\n\n${commentBody}`;
}

/**
 * Defense-in-depth: strip a trailing ```json fence from any agent comment. If
 * the extraction failed to strip the agent's structured JSON block — truncated
 * mid-JSON or complete — the raw fence would leak into the posted comment.
 * Returns null when the fence was the whole body.
 */
function stripTrailingFence(
	commentBody: string,
	agentName: string,
	collector?: ErrorCollector,
): string | null {
	const lastFence = commentBody.lastIndexOf("\n```json");
	if (lastFence === -1) return commentBody;
	const trimmed = commentBody.slice(0, lastFence).trim();
	if (trimmed.length >= 50) return trimmed;
	warn(
		collector,
		`${agentName} commentBody is only a broken \`\`\`json fence — skipping post. ` +
			`commentBody starts with: ${JSON.stringify(commentBody.slice(0, EMPTY_BODY_PREVIEW))}`,
	);
	return null;
}

/**
 * When the researcher exceeded its budget, compose one combined comment with a
 * "stopped early" header plus the partial findings, so the budget-exceeded
 * handler in handler.ts can skip its own separate comment (no duplication).
 * The existing heading is replaced to avoid redundant headings.
 */
function applyBudgetHeader(commentBody: string, result: AgentRunResult): string {
	const budgetHeader =
		`## Research Findings — Research stopped early: agent exceeded token budget ` +
		`(${result.tokenCount} tokens used). Pipeline continues without full research findings.`;
	const firstNewline = commentBody.indexOf("\n");
	return firstNewline === -1 ? budgetHeader : budgetHeader + commentBody.slice(firstNewline);
}

/**
 * Post-process a comment body: researcher empty-findings validation,
 * required-heading inject/skip, trailing broken ```json fence strip,
 * and budget-exceeded "stopped early" header.
 * Returns the final body, or null when the comment should not be posted.
 */
function prepareCommentBody(
	commentBody: string | null,
	agentName: string,
	result: AgentRunResult,
	extractionSource: string,
	collector?: ErrorCollector,
): string | null {
	const rule = ROLE_HEADINGS[agentName];
	let body = commentBody;
	if (body && agentName === "researcher") {
		body = validateResearcherBody(body, extractionSource, collector);
	}
	if (body && rule) {
		body = applyHeadingPolicy(body, rule, agentName, extractionSource, collector);
	}
	if (body) body = stripTrailingFence(body, agentName, collector);
	if (body && agentName === "researcher" && result.budgetExceeded) {
		body = applyBudgetHeader(body, result);
	}
	return body;
}

/** Post one comment; a post failure is a warning, never a thrown pipeline error. */
async function postComment(
	post: CommentPost,
	body: string,
	notifyMsg: string,
	failLabel: string,
): Promise<void> {
	try {
		if (post.port) await post.port.postIssueComment(post.issueNum, post.repo, body);
		post.ctx.ui.notify(notifyMsg, "info");
	} catch (commentErr: unknown) {
		warn(
			post.collector,
			`Failed to post ${failLabel}: ${
				commentErr instanceof Error ? commentErr.message : String(commentErr)
			}`,
		);
	}
}

/** Raw-output preview used by the "nothing to post" warnings. */
function outputPreview(result: AgentRunResult): string {
	return (
		`textOutput: ${JSON.stringify((result.textOutput || "").slice(0, 200))}, ` +
		`output: ${JSON.stringify((result.output || "").slice(0, 200))}`
	);
}

/**
 * Graceful degradation: a researcher with no commentBody still posts a
 * "no findings" comment so the issue has visible researcher output. Prevents a
 * silent skip when the LLM treats commentBody as optional and omits it.
 * The warning only fires when no valid structured JSON was produced at all
 * (crash or parse failure) — a researcher that answered "nothing to research"
 * did so on purpose.
 */
async function postResearchFallback(
	post: CommentPost,
	result: AgentRunResult,
	agentName: string,
): Promise<void> {
	const researcherOutput = result.textOutput || result.output || "";
	const parseResult = parseAgentOutput(researcherOutput, new Set(result.toolCalls ?? []));
	if (!isAgentOutputSuccess(parseResult)) {
		warn(
			post.collector,
			`${agentName} completed but no commentBody in JSON output. ` +
				`Posting graceful degradation comment. ` +
				outputPreview(result),
		);
	}
	await postComment(
		post,
		RESEARCH_FALLBACK,
		`Posted ${agentName} comment (graceful degradation) on issue #${post.issueNum}`,
		`${agentName} graceful degradation comment`,
	);
}

/**
 * Post the final comment body, or fall back to graceful degradation when no body
 * survived processing. Comment-post failures never return false — the pipeline
 * continues (advisory invariant).
 */
async function postCommentOrFallback(
	post: CommentPost,
	result: AgentRunResult,
	agentName: string,
	commentBody: string | null,
): Promise<void> {
	if (commentBody) {
		await postComment(
			post,
			commentBody,
			`Posted ${agentName} comment on issue #${post.issueNum}`,
			`${agentName} comment`,
		);
		return;
	}
	if (agentName === "researcher") {
		await postResearchFallback(post, result, agentName);
		return;
	}
	warn(post.collector, `${agentName} completed but no commentBody found. ` + outputPreview(result));
}

/**
 * Handle post-agent-success comment side effects for architect,
 * test-designer, and researcher: extract → validate/inject heading →
 * post (or graceful degradation).
 */
export async function handleAgentComment(
	ctx: ExtensionCommandContext,
	result: AgentRunResult,
	agentName: string,
	issueNum: number,
	config: SupervisorConfig,
	collector?: ErrorCollector,
	port?: GitHubPort,
): Promise<void> {
	// Refusal: the agent declined the task. The pipeline handler (agent-loop)
	// owns refusal handling — it stops the pipeline and posts the refusal note
	// (refusal.commentBody when present, otherwise a generated message). Skip
	// normal comment extraction so nothing is posted twice and no spurious
	// "no commentBody found" warning fires.
	const output = result.textOutput || result.output || "";
	if (isRefused(parseAgentOutput(output, new Set(result.toolCalls ?? [])))) {
		return;
	}

	const { commentBody, extractionSource } = extractCommentBody(result, agentName, collector);
	const finalBody = prepareCommentBody(commentBody, agentName, result, extractionSource, collector);
	await postCommentOrFallback(
		{ ctx, port, issueNum, repo: config.repo, collector },
		result,
		agentName,
		finalBody,
	);
}
