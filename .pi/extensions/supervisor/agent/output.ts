// ─── Agent Output Parser ──────────────────────────────────────────
// Single deterministic parser for all agent outputs.
// Agents output structured JSON; this function parses and validates it.
// No regex fallback, no text marker scanning, no lastIndexOf lookups.

import type { AgentOutput, FailedParse, ParseResult, FindingSeverity, FilteredIssueData } from "../config/types.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { isToolCallLine } from "../lib/formatting.ts";
import { jsonrepair } from "jsonrepair";

// ─── ANSI Stripping ──────────────────────────────────────────────

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

// ─── Thinking Prefix Stripping ──────────────────────────────────────

/**
 * Strip "💭 " prefix from lines in text.
 *
 * When agents use `thinking: high`, the JSON output may be emitted inside
 * thinking blocks instead of text blocks. The event handlers push thinking
 * content to fullLog with the "💭 " prefix on each line. This prefix makes
 * the text invalid JSON, causing parseAgentOutput to fail.
 *
 * Stripping "💭 " from the start of each line recovers the original JSON
 * so it can be extracted and parsed correctly.
 */
const THINKING_PREFIX_RE = /^💭\s*/gm;

const VALID_SEVERITIES = new Set<FindingSeverity>(["critical", "warning", "suggestion"]);

// ─── JSON Extraction ──────────────────────────────────────────────

/**
 * Extract the last JSON object from a string.
 * Handles:
 * - Pure JSON input
 * - JSON embedded in markdown code fences (```json ... ```)
 * - JSON with surrounding text
 * - Multiple JSON objects (picks last)
 *
 * Brace matching uses simple quote toggle (every " toggles inString) to
 * be string-boundary aware — { and } inside JSON string values (e.g.,
 * tool args like {"pattern":"function.*{"}) are ignored. Simple toggle
 * works because unescaped content quotes almost always come in pairs,
 * so the net effect on string tracking is correct.
 *
 * Note: jsonrepair (called later in parseAgentOutput) handles content
 * quotes and literal newlines inside string values. The extraction step
 * only needs to skip { } inside strings — precision quote tracking is
 * not required here.
 */
function extractLastJson(raw: string): string {
	// Step 1: Strip 💭 prefix for code fence detection.
	// Agents with thinking:high emit JSON in thinking blocks, which
	// get pushed to fullLog with "💭 " per line. Stripping recovers
	// valid JSON content between fences.
	const fenceSearchText = raw.replace(THINKING_PREFIX_RE, "");

	// Step 2: Find all markdown code fence regions (```json or ```).
	// Unlike the old regex approach, we scan character-by-character
	// to find matching fence pairs. This correctly handles triple
	// backticks inside JSON string values (e.g. markdown code blocks
	// in commentBody) — they are inside a string and don't close the
	// outer fence. We track string boundaries to skip ``` inside strings.
	const fenceContents: string[] = [];
	let pos = 0;
	while (pos < fenceSearchText.length) {
		// Find opening ``` (optionally followed by "json")
		const fenceStart = fenceSearchText.indexOf("```", pos);
		if (fenceStart === -1) break;

		// Skip past optional language tag and newline
		let afterOpen = fenceStart + 3;
		if (fenceSearchText.startsWith("json", afterOpen)) {
			afterOpen += 4;
		}
		// Skip whitespace/newline after opening fence
		while (
			afterOpen < fenceSearchText.length &&
			(fenceSearchText[afterOpen] === " " ||
				fenceSearchText[afterOpen] === "\t" ||
				fenceSearchText[afterOpen] === "\n" ||
				fenceSearchText[afterOpen] === "\r")
		) {
			afterOpen++;
		}

		// Scan for closing ``` — string-boundary aware
		// We look for ``` that is NOT inside a JSON string value.
		let inString = false;
		let escaped = false;
		let fenceEnd = -1;
		for (let i = afterOpen; i < fenceSearchText.length; i++) {
			const ch = fenceSearchText[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (inString && ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				// Simple toggle — content quotes inside string values
				// almost always come in pairs, so the net effect on
				// string boundary tracking is correct. Using simple
				// toggle avoids false-positive structural close when
				// a content quote is followed by `,`, `}`, `]`, or `:`.
				inString = !inString;
				continue;
			}
			if (!inString && ch === "`" && fenceSearchText.startsWith("```", i)) {
				fenceEnd = i;
				break;
			}
		}

		if (fenceEnd !== -1) {
			fenceContents.push(fenceSearchText.slice(afterOpen, fenceEnd).trim());
			pos = fenceEnd + 3;
		} else {
			// Unclosed fence — skip past the opening
			pos = afterOpen;
		}
	}

	// If we found fence content, use the LAST one (JSON is final output)
	if (fenceContents.length > 0) {
		return fenceContents[fenceContents.length - 1];
	}

	// Step 2: No code fences — filter metadata lines then simple brace counting.
	// Lines starting with 🔧, ✓, ✗, 📋, 📊 are tool execution/debug markers pushed
	// to fullLog by event handlers. Their content may contain `{`, `}` from tool
	// args/results, which would corrupt simple brace counting.
	// These lines are never part of the agent's structured JSON output.
	//
	// Use fenceSearchText (💭 prefix already stripped) so JSON inside thinking
	// blocks is valid. Use SIMPLE brace counting (no string tracking) so
	// double-quotes in thinking content do NOT corrupt brace matching.
	const metadataLineRe = /^[\u{1F527}\u{2713}\u{2717}\u{1F4CB}\u{1F4CA}]/u;
	let braceCandidateRaw = fenceSearchText;
	// Check if any filtering is needed (either old-format metadata lines or new-format tool call lines)
	const needsMetadataFilter = metadataLineRe.test(fenceSearchText);
	const needsToolCallFilter = fenceSearchText.split("\n").some((l) => isToolCallLine(l));
	if (needsMetadataFilter || needsToolCallFilter) {
		const lines = fenceSearchText.split("\n");
		const filteredLines: string[] = [];
		for (const line of lines) {
			const trimmed = line.trimStart();
			if (!metadataLineRe.test(trimmed) && !isToolCallLine(trimmed)) {
				filteredLines.push(line);
			}
		}
		if (filteredLines.length > 0 && filteredLines.length < lines.length) {
			braceCandidateRaw = filteredLines.join("\n");
		}
	}

	// Step 3: String-boundary-aware brace counting — find all complete outermost {} pairs.
	// Uses the same inString/escaped tracking as Step 2's fence scanner to
	// ignore { and } inside JSON string values.
	// Metadata tool lines (🔧 ✓ ✗ 📋 📊) with {}/quotes are already filtered.
	// Returns the LAST complete outermost pair (agent's JSON is final output).
	let depth = 0;
	let lastStart = -1;
	let lastEnd = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < braceCandidateRaw.length; i++) {
		const ch = braceCandidateRaw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString && ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			// Simple toggle — content quotes inside string values
			// almost always come in pairs, so the net effect on
			// string boundary tracking is correct. Using simple
			// toggle avoids false-positive structural close when
			// a content quote is followed by `,`, `}`, `]`, or `:`.
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") {
			if (depth === 0) lastStart = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && lastStart >= 0) {
				lastEnd = i;
			}
		}
	}

	if (lastEnd >= 0 && lastStart >= 0) {
		return braceCandidateRaw.slice(lastStart, lastEnd + 1);
	}

	// No valid JSON structure found — return empty instead of raw text
	return "";
}

// ─── Validation Helpers ──────────────────────────────────────────

interface ValidationResult {
	valid: boolean;
	errors: string[];
}

function validateAgentOutput(data: Record<string, unknown>): ValidationResult {
	const errors: string[] = [];

	// action is required and must be a valid enum value
	if (data.action === undefined || data.action === null) {
		errors.push("Missing required field: 'action'");
	} else if (typeof data.action !== "string") {
		errors.push("'action' must be a string");
	} else if (!["COMPLETE", "APPROVED", "REJECTED"].includes(data.action)) {
		errors.push(`'action' must be one of: COMPLETE, APPROVED, REJECTED (got: ${data.action})`);
	}

	// agentName is required and must be a string
	if (data.agentName === undefined || data.agentName === null) {
		errors.push("Missing required field: 'agentName'");
	} else if (typeof data.agentName !== "string") {
		errors.push("'agentName' must be a string");
	}

	// refusal — if present, treat as rejection
	if (data.refusal !== undefined && data.refusal !== null) {
		if (typeof data.refusal === "string" && data.refusal.trim().length > 0) {
			errors.push(`Agent refused: ${data.refusal}`);
		}
	}

	// commentBody (optional, must be string if present)
	if (
		data.commentBody !== undefined &&
		data.commentBody !== null &&
		typeof data.commentBody !== "string"
	) {
		errors.push("'commentBody' must be a string if provided");
	}

	// prTitle (optional, must be string if present)
	if (data.prTitle !== undefined && data.prTitle !== null && typeof data.prTitle !== "string") {
		errors.push("'prTitle' must be a string if provided");
	}

	// prBody (optional, must be string if present)
	if (data.prBody !== undefined && data.prBody !== null && typeof data.prBody !== "string") {
		errors.push("'prBody' must be a string if provided");
	}

	// summary (optional, must be string if present)
	if (data.summary !== undefined && data.summary !== null && typeof data.summary !== "string") {
		errors.push("'summary' must be a string if provided");
	}

	// auditScore validation
	if (data.auditScore !== undefined && data.auditScore !== null) {
		if (typeof data.auditScore !== "object" || Array.isArray(data.auditScore)) {
			errors.push("'auditScore' must be an object with 'passing' and 'total' fields");
		} else {
			const score = data.auditScore as Record<string, unknown>;
			if (typeof score.passing !== "number" || typeof score.total !== "number") {
				errors.push("'auditScore.passing' and 'auditScore.total' must be numbers");
			} else {
				if (score.passing < 0 || score.total < 0) {
					errors.push("'auditScore.passing' and 'auditScore.total' must be non-negative");
				}
				if (score.passing > score.total) {
					errors.push(
						`'auditScore.passing' (${score.passing}) cannot exceed 'auditScore.total' (${score.total})`,
					);
				}
			}
		}
	}

	// findings validation
	if (data.findings !== undefined && data.findings !== null) {
		if (!Array.isArray(data.findings)) {
			errors.push("'findings' must be an array if provided");
		} else {
			for (let i = 0; i < data.findings.length; i++) {
				const f = data.findings[i];
				if (typeof f !== "object" || f === null) {
					errors.push(`findings[${i}] must be an object`);
					continue;
				}
				const finding = f as Record<string, unknown>;

				// severity
				if (
					typeof finding.severity !== "string" ||
					!VALID_SEVERITIES.has(finding.severity as FindingSeverity)
				) {
					errors.push(
						`findings[${i}].severity must be one of: ${Array.from(VALID_SEVERITIES).join(", ")}`,
					);
				}

				// dimension
				if (typeof finding.dimension !== "string") {
					errors.push(`findings[${i}].dimension must be a string`);
				}

				// symptom, consequence, remedy are required strings
				if (typeof finding.symptom !== "string" || finding.symptom.trim() === "") {
					errors.push(`findings[${i}].symptom is required and must be a non-empty string`);
				}
				if (typeof finding.consequence !== "string" || finding.consequence.trim() === "") {
					errors.push(`findings[${i}].consequence is required and must be a non-empty string`);
				}
				if (typeof finding.remedy !== "string" || finding.remedy.trim() === "") {
					errors.push(`findings[${i}].remedy is required and must be a non-empty string`);
				}

				// location (optional)
				if (
					finding.location !== undefined &&
					finding.location !== null &&
					typeof finding.location !== "string"
				) {
					errors.push(`findings[${i}].location must be a string if provided`);
				}
			}
		}
	}

	// targetStatus (optional, must be string if present)
	if (
		data.targetStatus !== undefined &&
		data.targetStatus !== null &&
		typeof data.targetStatus !== "string"
	) {
		errors.push("'targetStatus' must be a string if provided");
	}

	return { valid: errors.length === 0, errors };
}

// ─── Escape Normalization ──────────────────────────────────────────
// Normalize literal \\n / \\r sequences that survived JSON.parse into real newlines.
// Agents often produce \\n (double-escaped) in JSON string values.

function normalizeEscapes(s: string): string {
	return s.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

// ─── Main Parser ──────────────────────────────────────────────────

/**
 * Parse agent output into structured AgentOutput.
 *
 * Strategy:
 * 1. Strip ANSI escape sequences
 * 2. Extract JSON from text (code fences, surrounding text)
 * 3. Repair malformed JSON with jsonrepair, then JSON.parse
 * 4. Validate against schema
 *
 * Returns either a valid AgentOutput or a FailedParse with descriptive error.
 */
export function parseAgentOutput(output: string): ParseResult {
	// Guard against null/undefined/empty
	if (output === null || output === undefined) {
		return { error: "Output is null or undefined", rawOutput: String(output) };
	}

	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return { error: "Output is empty", rawOutput: output };
	}

	// Step 1: Strip ANSI escape sequences
	const clean = stripAnsi(trimmed);

	// Step 2: Extract JSON from text
	// 💭 prefix stripping occurs inside extractLastJson for code fence
	// detection. Brace matching uses simple brace counting (no string
	// tracking) so double-quotes in thinking content don't corrupt it.
	const jsonStr = extractLastJson(clean);
	if (!jsonStr) {
		getDebugLogger().warn("agent-output", "No JSON structure found in agent output", {
			outputLen: clean.length,
		});
		return { error: "No JSON structure found in agent output", rawOutput: output };
	}

	// Step 3: Repair (if needed) and parse JSON
	// jsonrepair handles the common malformed-JSON patterns agents produce:
	// unescaped quotes, literal newlines in strings, smart/unicode quotes,
	// trailing content after JSON, truncated JSON, etc.
	//
	// Phase 1 gate (instrument corpus → decide) was skipped per audit
	// finding #1. Decision: keep jsonrepair unconditionally. Rationale:
	// zero-transitive-dependency, zero-CVE, ~13yr mature library (2.4M
	// weekly downloads). The old heuristic (~180 LOC) is replaced with
	// upstream-owned correctness. If malformed-output rate is near-zero,
	// jsonrepair is still a negligible cost; if non-trivial, it's the
	// right tool. The ponytail alternative (plain JSON.parse, fail-loud)
	// would cause regressions on real patterns the heuristic rescued.
	let repaired: string;
	try {
		repaired = jsonrepair(jsonStr);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		getDebugLogger().warn("agent-output", `JSON repair failed: ${msg}`, {
			jsonLen: jsonStr.length,
		});
		return {
			error: `Failed to parse JSON from agent output: ${msg}`,
			rawOutput: output,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(repaired);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		getDebugLogger().warn("agent-output", `JSON parse failed after repair: ${msg}`, {
			jsonLen: jsonStr.length,
			repairedLen: repaired.length,
		});
		return {
			error: `Failed to parse JSON from agent output: ${msg}`,
			rawOutput: output,
		};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		getDebugLogger().warn("agent-output", "Parsed JSON not an object");
		return {
			error: "Parsed JSON must be an object (not array or primitive)",
			rawOutput: output,
		};
	}

	const data = parsed as Record<string, unknown>;

	// Step 4: Validate
	const validation = validateAgentOutput(data);
	if (!validation.valid) {
		getDebugLogger().warn(
			"agent-output",
			`Schema validation failed: ${validation.errors.join("; ")}`,
			{
				action: data.action,
				agentName: data.agentName,
			},
		);
		return {
			error: `Agent output schema validation failed: ${validation.errors.join("; ")}`,
			rawOutput: output,
		};
	}

	// Normalize escaped newlines — uses module-level normalizeEscapes

	// Step 5: Build typed AgentOutput
	const result: AgentOutput = {
		action: data.action as AgentOutput["action"],
		agentName: data.agentName as string,
	};

	if (data.summary !== undefined && data.summary !== null) {
		result.summary = data.summary as string;
	}
	if (data.commentBody !== undefined && data.commentBody !== null) {
		result.commentBody = normalizeEscapes(data.commentBody as string);
	}
	if (data.prTitle !== undefined && data.prTitle !== null) {
		result.prTitle = data.prTitle as string;
	}
	if (data.prBody !== undefined && data.prBody !== null) {
		result.prBody = normalizeEscapes(data.prBody as string);
	}
	if (data.auditScore !== undefined && data.auditScore !== null) {
		result.auditScore = data.auditScore as { passing: number; total: number };
	}
	if (data.findings !== undefined && data.findings !== null) {
		result.findings = data.findings as AgentOutput["findings"];
	}
	if (data.targetStatus !== undefined && data.targetStatus !== null) {
		result.targetStatus = data.targetStatus as string;
	}

	return result;
}

/**
 * Check if a ParseResult is a successful AgentOutput.
 */
export function isSuccess(result: ParseResult): result is AgentOutput {
	return "action" in result && "agentName" in result;
}

// ─── Structured Audit Output ────────────────────────────────────

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
	if (isSuccess(parseResult)) {
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
		// Fallback 2: section heading detection
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
			slice = stripTrailingMetadata(slice, heading.length);

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
		const bodyEndIdx = body.lastIndexOf("COMMENT_BODY_END");
		if (bodyEndIdx !== -1) {
			body = body.slice(0, bodyEndIdx).trim();
		}
		result.commentBody = body;
	}

	return result;
}

// ─── Agent Comment Body Extraction ────────────────────────────────

export function extractAgentCommentBody(output: string): string | null {
	const parseResult = parseAgentOutput(output);
	if (isSuccess(parseResult)) {
		const agentOutput = parseResult as AgentOutput;
		if (agentOutput.commentBody) return agentOutput.commentBody;
	}

	// Fallback: COMMENT_BODY marker extraction
	const startMarker = /COMMENT_BODY\s*:\s*/g;
	let lastBody: string | null = null;
	let match;
	while ((match = startMarker.exec(output)) !== null) {
		const start = match.index + match[0].length;
		const endIdx = output.indexOf("COMMENT_BODY_END", start);
		const body = endIdx !== -1 ? output.slice(start, endIdx) : output.slice(start);
		lastBody = body.trim();
	}

	// Fallback 2: structured section heading extraction
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
			slice = stripTrailingMetadata(slice, bestHeading.length);

			const lastJsonFence = slice.lastIndexOf("\n```json");
			if (lastJsonFence > bestHeading.length + 20) {
				const beforeFence = slice.slice(0, lastJsonFence).trim();
				if (beforeFence.length > bestHeading.length + 20) {
					slice = beforeFence;
				}
			}

			if (slice.length > bestHeading.length + 20) {
				lastBody = slice;
			}
		}
	}

	const METADATA_LINE_RE = /^[\u{1F527}\u{2713}\u{2717}\u{1F4CB}\u{1F4CA}\u{1F4AD}]/u;
	const REASONING_LINE_RE =
		/^(Now (let me|I|we)|Let me|I need to|I'll|First,? let me|I should|I think|I'm going|Let's|Here's my|My approach|I will)/i;
	const NDJSON_LINE_RE = /^\{\s*"(?:type|role)"\s*:/;
	const MESSAGES_LINE_RE = /^\{\s*"messages"\s*:\s*\[/;
	const stripNoise = (text: string): string => {
		return text
			.split("\n")
			.filter((line) => {
				const trimmed = line.trim();
				if (!trimmed) return true;
				if (METADATA_LINE_RE.test(trimmed)) return false;
				if (isToolCallLine(trimmed)) return false;
				if (REASONING_LINE_RE.test(trimmed)) return false;
				if (NDJSON_LINE_RE.test(trimmed)) return false;
				if (MESSAGES_LINE_RE.test(trimmed)) return false;
				return true;
			})
			.join("\n")
			.trim();
	};

	function isContaminated(text: string): boolean {
		const ndjsonPattern = /\{\s*"(?:type|role|messages)"\s*[:\[]/g;
		const matches = text.match(ndjsonPattern);
		if (!matches) return false;
		return matches.length >= 2;
	}

	if (lastBody) {
		lastBody = normalizeEscapes(lastBody);
		const stripped = stripNoise(lastBody);
		if (stripped.length >= 50) {
			lastBody = stripped;
		}
		if (lastBody && isContaminated(lastBody)) {
			return null;
		}
	}

	return lastBody;
}

// ─── Trailing Metadata Stripping ─────────────────────────────────

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

	truncatePos = stripTraditionalJsonEnd(slice, minHeadingLen, truncatePos);

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

	const ndjsonLineRe = /\n\{\s*"(?:type|role)"\s*:/;
	const ndjsonMatch = slice.match(ndjsonLineRe);
	if (ndjsonMatch?.index && ndjsonMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, ndjsonMatch.index);
	}

	const agentEndRe = /\n\s*"willRetry"\s*:/;
	const agentEndMatch = slice.match(agentEndRe);
	if (agentEndMatch?.index && agentEndMatch.index > minHeadingLen + 20) {
		truncatePos = Math.min(truncatePos, agentEndMatch.index);
	}

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
