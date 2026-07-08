// ─── Issue Comment Operations ─────────────────────────────────────
// postIssueComment, extractStructuredAuditOutput (now uses parseAgentOutput),
// extractAgentCommentBody, and filterIssueData.
//
// The old regex-based builders (buildAuditCommentFallback, etc.) have been
// removed. All audit comment construction now goes through parseAgentOutput.

import { writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";
import type { ExecFn } from "../pipeline/helpers.ts";
import type { FilteredIssueData, AgentOutput } from "../config/types.ts";
import { gh } from "./gh-client.ts";
import {
	parseAgentOutput,
	isSuccess as isAgentOutputSuccess,
	normalizeEscapes,
} from "../agent/output.ts";
import { isToolCallLine } from "../lib/render-helpers.ts";
import { getDebugLogger } from "../lib/debug.ts";

// ─── Post Issue Comment ───────────────────────────────────────────

/**
 * Hard safety limit for GitHub comment body length.
 * Prevents agent execution logs (fullLog with tool calls, thinking,
 * results) from being posted as issue comments if upstream extraction
 * or builder logic has a bug.
 *
 * This is a defense-in-depth cap (50KB) that only catches pathological
 * full-log dumps while allowing legitimate long comments through.
 */
const MAX_COMMENT_CHARS = 50_000;

export async function postIssueComment(
	exec: ExecFn,
	issueNum: number,
	repo: string,
	body: string,
): Promise<void> {
	const log = getDebugLogger();
	// Normalize escaped newlines as final safety net.
	// Catches literal \\n sequences from any extraction path (JSON parsing,
	// heading fallback, COMMENT_BODY marker, audit output fallback).
	const normalized = normalizeEscapes(body);
	// Truncate as defense-in-depth against full-log dumps.
	// Full agent logs are typically 100K+ chars; legitimate comments are
	// under 10K chars. If body exceeds the hard limit, it's almost certainly
	// a bug — truncate and append overflow notice instead of posting raw log.
	const truncated =
		normalized.length > MAX_COMMENT_CHARS
			? normalized.slice(0, MAX_COMMENT_CHARS) +
				"\n\n---\n⚠️ **Comment truncated at 50,000 character safety limit** — a bug likely caused the full agent execution log to be included. Please report this."
			: normalized;
	const preview = truncated.slice(0, 200).replace(/\n/g, " ");
	log.info("comment", `Posting comment on #${issueNum} (${repo})`, {
		issueNum,
		repo,
		bodyLen: normalized.length,
		truncated: normalized.length > MAX_COMMENT_CHARS,
		preview,
	});

	// Write body to temp file to avoid shell interpreting special characters.
	// Per AGENTS.md: save to ignore/ folder, delete after use.
	const tempFile = joinPath("ignore", `comment-body-${issueNum}-${Date.now()}.md`);
	try {
		await mkdir(dirname(tempFile), { recursive: true });
		await writeFile(tempFile, truncated, "utf-8");
	} catch (writeErr: unknown) {
		const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
		log.error("comment", `Failed to write comment body temp file: ${writeMsg}`);
		throw new Error(`Failed to write comment body temp file: ${writeMsg}`);
	}

	try {
		await gh(exec, ["issue", "comment", String(issueNum), "--repo", repo, "--body-file", tempFile]);
		log.info("comment", `Comment posted on #${issueNum}`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error("comment", `Failed to post comment on #${issueNum}`, {
			error: msg,
			issueNum,
			repo,
		});
		throw err;
	} finally {
		// Clean up temp file
		try {
			await unlink(tempFile);
			log.debug("comment", `Temp file deleted: ${tempFile}`);
		} catch (cleanupErr: unknown) {
			const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
			log.warn("comment", `Failed to delete temp file ${tempFile}: ${cleanupMsg}`);
		}
	}
}

// ─── Structured Audit Output ──────────────────────────────────────
// Uses parseAgentOutput as the primary method. Falls back to text marker
// detection only for backward compatibility during agent template transition.

export interface StructuredAuditOutput {
	decision: "APPROVED" | "REJECTED";
	prTitle?: string;
	prBody?: string;
	commentBody?: string;
}

/**
 * Extract structured audit output from agent output.
 * Primary path: parseAgentOutput for structured JSON.
 * Fallback: text marker regex detection (backward compat).
 */
export function extractStructuredAuditOutput(output: string): StructuredAuditOutput | null {
	// Primary: parseAgentOutput
	const parseResult = parseAgentOutput(output);
	if (isAgentOutputSuccess(parseResult)) {
		const agentOutput = parseResult as AgentOutput;
		if (agentOutput.action === "APPROVED" || agentOutput.action === "REJECTED") {
			const result: StructuredAuditOutput = {
				decision: agentOutput.action,
			};
			if (agentOutput.commentBody) result.commentBody = agentOutput.commentBody;
			if (agentOutput.prTitle) result.prTitle = agentOutput.prTitle;
			if (agentOutput.prBody) result.prBody = agentOutput.prBody;
			return result;
		}
	}

	// Fallback: text marker detection (backward compat)
	const decisionMatch = output.match(/AUDIT_DECISION\s*:\s*(APPROVED|REJECTED)/g);
	const standaloneApproved = output.match(/\bAUDIT_APPROVED\b/g);
	const standaloneRejected = output.match(/\bAUDIT_REJECTED\b/g);

	if (!decisionMatch && !standaloneApproved && !standaloneRejected) {
		// Fallback 2: section heading detection for ## Audit Approved / ## Audit Rejected
		// When agent outputs structured markdown without JSON or text markers.
		const approvedHeading = "## Audit Approved";
		const rejectedHeading = "## Audit Rejected";
		const approvedIdx = output.lastIndexOf(approvedHeading);
		const rejectedIdx = output.lastIndexOf(rejectedHeading);

		if (approvedIdx !== -1 || rejectedIdx !== -1) {
			let decision: "APPROVED" | "REJECTED";
			let heading: string;
			let bodyStart: number;

			if (approvedIdx > rejectedIdx) {
				decision = "APPROVED";
				heading = approvedHeading;
				bodyStart = approvedIdx;
			} else {
				decision = "REJECTED";
				heading = rejectedHeading;
				bodyStart = rejectedIdx;
			}

			let slice = output.slice(bodyStart).trim();
			// Strip trailing JSON blocks, thinking text, and instrumentation
			// that may follow the markdown heading (agent output often has
			// the JSON block appended after the commentBody text).
			slice = stripTrailingMetadata(slice, heading.length);

			// Strip trailing ```json code fence (structured output, not comment body).
			// When agent output contains a JSON block after the markdown heading, it's the
			// structured output that should NOT be posted as part of the issue comment.
			const lastJsonFence = slice.lastIndexOf("\n```json");
			if (lastJsonFence > heading.length + 20) {
				const beforeFence = slice.slice(0, lastJsonFence).trim();
				if (beforeFence.length > heading.length + 20) {
					slice = beforeFence;
				}
			}

			if (slice.length > heading.length + 20) {
				return { decision, commentBody: slice };
			}
		}

		return null;
	}

	let decision: "APPROVED" | "REJECTED";
	if (decisionMatch && decisionMatch.length > 0) {
		const lastDecision = decisionMatch[decisionMatch.length - 1];
		decision = lastDecision.includes("APPROVED") ? ("APPROVED" as const) : ("REJECTED" as const);
	} else if (standaloneApproved && standaloneApproved.length > 0) {
		const lastStandalone = standaloneApproved[standaloneApproved.length - 1];
		const approvedIdx = output.lastIndexOf(lastStandalone);
		const rejectedIdx = standaloneRejected
			? output.lastIndexOf(standaloneRejected[standaloneRejected.length - 1])
			: -1;
		decision = approvedIdx > rejectedIdx ? "APPROVED" : "REJECTED";
	} else {
		decision = "REJECTED";
	}

	const result: StructuredAuditOutput = { decision };

	const prTitleMatch = output.match(/PR_TITLE\s*:\s*(.+)$/gm);
	if (prTitleMatch) {
		result.prTitle = prTitleMatch[prTitleMatch.length - 1].replace(/^PR_TITLE\s*:\s*/i, "").trim();
	}

	const prBodyMatch = output.match(
		/PR_BODY\s*:[^\S\n]*([\s\S]*?)(?=\n(?:COMMENT_BODY|SUBMODULE_PR|PR_TITLE)\s*:|$)/,
	);
	if (prBodyMatch) {
		result.prBody = prBodyMatch[1].trim();
	}

	const commentBodyMatch = output.match(
		/COMMENT_BODY\s*:[^\S\n]*([\s\S]*?)(?=\n(?:SUBMODULE_PR|AUDIT_DECISION)\s*:|$)/,
	);
	if (commentBodyMatch) {
		let body = commentBodyMatch[1].trim();
		// Strip trailing COMMENT_BODY_END if present (safety)
		const bodyEndIdx = body.lastIndexOf("COMMENT_BODY_END");
		if (bodyEndIdx !== -1) {
			body = body.slice(0, bodyEndIdx).trim();
		}
		result.commentBody = body;
	}

	return result;
}

// ─── Agent Comment Body Extraction ────────────────────────────────
// Tries parseAgentOutput first for structured commentBody,
// falls back to COMMENT_BODY marker extraction.

export function extractAgentCommentBody(output: string): string | null {
	// Primary: parseAgentOutput for structured JSON
	const parseResult = parseAgentOutput(output);
	if (isAgentOutputSuccess(parseResult)) {
		const agentOutput = parseResult as AgentOutput;
		if (agentOutput.commentBody) return agentOutput.commentBody;
		// JSON parsed but commentBody missing/empty — fall through
		// to regex extraction for backward compatibility with
		// text marker fallbacks.
	}

	// Fallback: COMMENT_BODY marker extraction
	const startMarker = /COMMENT_BODY\s*:\s*/g;
	const endMarker = /COMMENT_BODY_END/g;

	let lastBody: string | null = null;
	let match;
	while ((match = startMarker.exec(output)) !== null) {
		const start = match.index + match[0].length;
		const endIdx = output.indexOf("COMMENT_BODY_END", start);
		const body = endIdx !== -1 ? output.slice(start, endIdx) : output.slice(start);
		lastBody = body.trim();
	}

	// Fallback 2: structured section heading extraction
	// When agent outputs markdown with ## Architecture / ## Research Findings / ## Test Plan /
	// ## Audit (Approved|Rejected) but without COMMENT_BODY markers or valid JSON.
	// Extract from the last occurrence of a known heading to end of output.
	//
	// IMPORTANT: Use exact heading matching, not prefix substring matching.
	// lastIndexOf("## Architecture") also matches "## Architecture risk flag" because
	// "## Architecture" is a prefix of "## Architecture risk flag". This causes the
	// extraction to pick up the wrong content when agent output contains non-standard
	// headings that happen to start with a known heading string.
	if (!lastBody) {
		const sectionHeadings = [
			"## Architecture",
			"## Research Findings",
			"## Test Plan",
			"## Audit Approved",
			"## Audit Rejected",
		];
		let bestIdx = -1;
		let bestHeading = "";
		for (const heading of sectionHeadings) {
			// Use regex for exact match — heading must be followed by newline, space, or end-of-string.
			// This prevents prefix matches (e.g. "## Architecture" matching "## Architecture risk flag").
			const headingRegex = new RegExp(
				heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$)",
				"gm",
			);
			let match;
			let lastMatch: RegExpExecArray | null = null;
			while ((match = headingRegex.exec(output)) !== null) {
				lastMatch = match;
			}
			if (lastMatch && lastMatch.index > bestIdx) {
				bestIdx = lastMatch.index;
				bestHeading = heading;
			}
		}
		if (bestIdx !== -1) {
			let slice = output.slice(bestIdx).trim();
			// Strip trailing JSON blocks, thinking text, and instrumentation
			// that may follow the markdown heading.
			slice = stripTrailingMetadata(slice, bestHeading.length);

			// Strip trailing ```json code fence (structured output, not comment body).
			// When agent output is truncated mid-JSON, the heading extraction includes
			// the broken JSON block at the end (```json\n{... without closing }).
			// Strip the entire trailing ```json block regardless of completeness —
			// it's the agent's structured output, not part of the issue comment.
			const lastJsonFence = slice.lastIndexOf("\n```json");
			if (lastJsonFence > bestHeading.length + 20) {
				const beforeFence = slice.slice(0, lastJsonFence).trim();
				if (beforeFence.length > bestHeading.length + 20) {
					slice = beforeFence;
				}
			}

			// Only use extraction if it looks like substantive content (>100 chars, not just heading)
			if (slice.length > bestHeading.length + 20) {
				lastBody = slice;
			}
		}
	}

	// Strip tool/thinking/instrumentation metadata lines from extracted content.
	// The section heading extraction operates on textOutput (full instrumented
	// log with tool calls, thinking, results, context info). These metadata
	// lines start with emoji prefixes: 🔧 (tool start), ✓/✗ (tool end),
	// 📋 (tool result), 💭 (thinking), 📊 (context info).
	// If the agent's section heading appears before the final text output,
	// the extraction from heading to end-of-log would include these
	// metadata lines, making the comment look like "the whole log".
	// Strip them to produce clean commentBody text.
	// Also strip reasoning/self-talk lines that LLMs sometimes leak into output.
	const METADATA_LINE_RE = /^[\u{1F527}\u{2713}\u{2717}\u{1F4CB}\u{1F4CA}\u{1F4AD}]/u;
	const REASONING_LINE_RE =
		/^(Now (let me|I|we)|Let me|I need to|I'll|First,? let me|I should|I think|I'm going|Let's|Here's my|My approach|I will)/i;
	// NDJSON event lines (raw stdout from pi --mode json) and session entry lines
	// leak system prompts, tool results, model metadata, token usage.
	// Detect: {"type":..., {"role":..., or lines containing "messages":[...
	const NDJSON_LINE_RE = /^\{\s*"(?:type|role)"\s*:/;
	const MESSAGES_LINE_RE = /^\{\s*"messages"\s*:\s*\[/;
	const stripNoise = (text: string): string => {
		return text
			.split("\n")
			.filter((line) => {
				const trimmed = line.trim();
				if (!trimmed) return true; // keep blank lines
				// Skip tool/thinking/instrumentation lines (old + new format)
				if (METADATA_LINE_RE.test(trimmed)) return false;
				if (isToolCallLine(trimmed)) return false;
				// Skip reasoning/self-talk lines that indicate LLM internal monologue
				if (REASONING_LINE_RE.test(trimmed)) return false;
				// Skip NDJSON event lines ({"type":"...}) and session entries ({"role":"...})
				// that leak into section heading extraction from raw stdout.
				if (NDJSON_LINE_RE.test(trimmed)) return false;
				if (MESSAGES_LINE_RE.test(trimmed)) return false;
				return true;
			})
			.join("\n")
			.trim();
	};

	// Detect residual NDJSON contamination after noise stripping.
	// If the text still contains unprocessed NDJSON artifacts from pi
	// subprocess stdout ({"type":..., {"role":..., {"messages":[...),
	// reject the entire extraction to prevent data leaks.
	// Use substring checks (not line-based) since artifacts can span
	// across line boundaries after noise stripping.
	function isContaminated(text: string): boolean {
		const ndjsonPattern = /\{\s*"(?:type|role|messages)"\s*[:\[]/g;
		const matches = text.match(ndjsonPattern);
		if (!matches) return false;
		// A single match might be a false positive from content text
		// (e.g. issue body mentioning {"type":"..."}). Multiple matches
		// indicate actual JSON event/session contamination.
		return matches.length >= 2;
	}

	// Normalize escaped newlines in fallback extractions.
	// When JSON parsing fails and we extract from raw text, literal \\n
	// sequences from JSON string values survive. Convert to real newlines.
	if (lastBody) {
		lastBody = normalizeEscapes(lastBody);
		// Strip metadata noise unless the result is too short after stripping
		const stripped = stripNoise(lastBody);
		if (stripped.length >= 50) {
			lastBody = stripped;
		}
		// Security: reject extraction if residual NDJSON/session contamination
		// survives noise stripping. Prevents system prompt and full conversation
		// history from leaking into GitHub comments when fallback 2 (section heading
		// extraction) operates on raw subprocess stdout containing agent_end events.
		if (lastBody && isContaminated(lastBody)) {
			return null;
		}
	}

	return lastBody;
}

// ─── Filter Issue Data (Security) ─────────────────────────────────

export interface RawIssueData {
	author?: { login: string };
	body?: string;
	comments?: Array<{ author?: { login: string }; body?: string }>;
}

export function filterIssueData(rawIssue: RawIssueData, codeowners: string[]): FilteredIssueData {
	const issueAuthor: string = rawIssue?.author?.login || "";
	const isIssueAuthorTrusted = codeowners.includes(issueAuthor);

	const body = isIssueAuthorTrusted
		? rawIssue?.body || "(no body)"
		: `[Issue body hidden — author @${issueAuthor} is not a trusted codeowner]`;

	const rawComments = rawIssue?.comments || [];
	const trustedComments = rawComments
		.filter((c) => {
			const commentAuthor: string = c?.author?.login || "";
			return codeowners.includes(commentAuthor);
		})
		.map((c) => ({
			author: c?.author?.login || "unknown",
			body: c?.body || "",
		}));

	return {
		body,
		comments: trustedComments,
	};
}

/**
 * Strip trailing JSON blocks, thinking text, and instrumentation metadata
 * from a markdown slice. Used to clean up agent output when extracting
 * comment bodies from structured audit output and agent comment bodies.
 *
 * The minHeadingLen + 20 boundary guard prevents truncation when the
 * metadata is too close to the heading (likely part of the content, not
 * trailing output).
 */
function stripTraditionalJsonEnd(
	slice: string,
	minHeadingLen: number,
	truncatePos: number,
): number {
	const jsonEndRe = /\n\s*"(?:auditScore|findings|action)"\s*:/;
	const jsonMatch = slice.match(jsonEndRe);
	if (jsonMatch?.index && jsonMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, jsonMatch.index);
	}
	return truncatePos;
}

export function stripTrailingMetadata(slice: string, minHeadingLen: number): string {
	let truncatePos = slice.length;

	// Strip known agent JSON keys that mark end of substantive content
	truncatePos = stripTraditionalJsonEnd(slice, minHeadingLen, truncatePos);

	// Strip 💭 thinking and 📊 context info lines
	const thinkEndRe = /\n💭/;
	const instrEndRe = /\n📊/;
	const thinkMatch = slice.match(thinkEndRe);
	if (thinkMatch?.index && thinkMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, thinkMatch.index);
	}
	const instrMatch = slice.match(instrEndRe);
	if (instrMatch?.index && instrMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, instrMatch.index);
	}

	// Strip NDJSON event lines (raw stdout from pi --mode json contains
	// events like {"type":"agent_end","messages":[...]}, {"type":"text_end"},
	// {"type":"message_end"}, and session entries like {"role":"system",...}.
	// These leak system prompts, tool results, model metadata, and token usage.
	// The section heading extraction finds ## Research Findings inside an NDJSON
	// event's string value, slices to end-of-stdout, and would include all
	// subsequent JSON events (agent_end with full conversation).
	// Strip any line that starts with {"type":, {"role":, or contains "messages":[
	const ndjsonLineRe = /\n\{\s*"(?:type|role)"\s*:/;
	const ndjsonMatch = slice.match(ndjsonLineRe);
	if (ndjsonMatch?.index && ndjsonMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, ndjsonMatch.index);
	}

	// Also strip trailing agent_end or willRetry markers
	const agentEndRe = /\n\s*"willRetry"\s*:/;
	const agentEndMatch = slice.match(agentEndRe);
	if (agentEndMatch?.index && agentEndMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, agentEndMatch.index);
	}

	// Strip lines starting with "messages": (session dump in agent_end)
	const messagesRe = /\n\s*"messages"\s*:\s*\[/;
	const messagesMatch = slice.match(messagesRe);
	if (messagesMatch?.index && messagesMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, messagesMatch.index);
	}

	if (truncatePos < slice.length) {
		const trimmed = slice.slice(0, truncatePos).trim();
		if (trimmed.length > minHeadingLen + 20) {
			return trimmed;
		}
	}
	return slice;
}
