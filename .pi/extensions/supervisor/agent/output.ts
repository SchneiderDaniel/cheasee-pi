// ─── Agent Output Parser — Facade ────────────────────────────────
// Single deterministic parser for all agent outputs.
// Agents output structured JSON; this function parses and validates it.
// No regex fallback, no text marker scanning, no lastIndexOf lookups.
//
// Facade module: owns parseAgentOutput, extractAgentCommentBody,
// isSuccess, stripAnsi, normalizeEscapes and the parse-first
// extractStructuredAuditOutput. Parsing internals live in leaf modules
// (last-json-scanner.ts, validation.ts, structured-audit.ts) — imports
// flow one-way in here, never out. Callers keep importing from this
// path; the leaf exports are internal surface, not re-exported.

import type { AgentOutput, FailedParse, ParseResult } from "../config/types.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { isToolLine } from "../lib/tool-line.ts";
import {
	extractLastJson,
	sanitizeJsonStrings,
	sanitizeJsonStringsConservative,
} from "./last-json-scanner.ts";
import { validateAgentOutput } from "./validation.ts";
import { extractStructuredAuditMarkers, stripTrailingMetadata } from "./structured-audit.ts";
import type { StructuredAuditOutput } from "./structured-audit.ts";

export type { StructuredAuditOutput } from "./structured-audit.ts";
export { stripTrailingMetadata } from "./structured-audit.ts";

// ─── ANSI Stripping ──────────────────────────────────────────────

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

// ─── Escape Normalization ──────────────────────────────────────────
// Normalize literal \\n / \\r sequences that survived JSON.parse into real newlines.
// Agents often produce \\n (double-escaped) in JSON string values.

export function normalizeEscapes(s: string): string {
	return s.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

// ─── Main Parser ──────────────────────────────────────────────────

/**
 * Parse agent output into structured AgentOutput.
 *
 * Strategy:
 * 1. Strip ANSI escape sequences
 * 2. Extract JSON from text (code fences, surrounding text)
 * 3. JSON.parse the extracted text
 * 4. Validate against schema
 *
 * Returns either a valid AgentOutput or a FailedParse with descriptive error.
 */
export function parseAgentOutput(output: string, toolNames?: Set<string>): ParseResult {
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
	const jsonStr = extractLastJson(clean, toolNames);
	if (!jsonStr) {
		getDebugLogger().warn("agent-output", "No JSON structure found in agent output", {
			outputLen: clean.length,
		});
		return { error: "No JSON structure found in agent output", rawOutput: output };
	}

	// Step 2.5: Sanitize JSON — escape literal newlines inside string values
	// Agents often produce commentBody with actual newlines instead of \\n escapes
	const sanitized = sanitizeJsonStrings(jsonStr);

	// Step 3: Parse JSON (sanitized to handle literal newlines in strings)
	let parsed: unknown;
	try {
		parsed = JSON.parse(sanitized);
	} catch (e: unknown) {
		// Retry with conservative strategy — treats `"` followed by `,` or `:`
		// as content quotes (not structural close) to handle the false-positive
		// pattern where unescaped quotes inside string values are followed by
		// delimiters (e.g. `"key",` or `"value":` inside commentBody).
		try {
			parsed = JSON.parse(sanitizeJsonStringsConservative(jsonStr));
		} catch {
			// Both passes failed — fall through to auto-recovery
		}

		if (!parsed) {
			const msg = e instanceof Error ? e.message : String(e);

			// Auto-recovery: trailing non-JSON content (e.g. agent appends text after JSON)
			// Error like "Unexpected non-whitespace character after JSON at position 3137"
			const posMatch = msg.match(/position (\d+)/);
			if (posMatch) {
				const pos = parseInt(posMatch[1], 10);
				if (pos > 10 && pos < sanitized.length) {
					try {
						parsed = JSON.parse(sanitized.slice(0, pos));
					} catch {
						// retry failed — fall through to error return
					}
				}
			}
		}

		if (!parsed) {
			const msg = e instanceof Error ? e.message : String(e);
			getDebugLogger().warn("agent-output", `JSON parse failed: ${msg}`, {
				jsonLen: jsonStr.length,
				sanitizedLen: sanitized.length,
			});
			return {
				error: `Failed to parse JSON from agent output: ${msg}`,
				rawOutput: output,
			};
		}
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

// ─── Agent Comment Body Extraction ────────────────────────────────
// Tries parseAgentOutput first for structured commentBody,
// falls back to COMMENT_BODY marker extraction.

export function extractAgentCommentBody(output: string, toolNames?: Set<string>): string | null {
	// Primary: parseAgentOutput for structured JSON
	const parseResult = parseAgentOutput(output, toolNames);
	if (isSuccess(parseResult)) {
		const agentOutput = parseResult as AgentOutput;
		if (agentOutput.commentBody) return agentOutput.commentBody;
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

			const lastJsonFence = slice.lastIndexOf("\n\`\`\`json");
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

	// Strip metadata lines from extracted content
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
				if (isToolLine(trimmed, toolNames)) return false;
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

// ─── Structured Audit Output ──────────────────────────────────────

/**
 * Extract structured audit output from agent output.
 *
 * Parse-first strategy: when the output parses as JSON with an
 * APPROVED/REJECTED action, derive the result from the structured
 * fields. Otherwise fall back to text markers / heading detection in
 * structured-audit.ts (extractStructuredAuditMarkers).
 */
export function extractStructuredAuditOutput(
	output: string,
	toolNames?: Set<string>,
): StructuredAuditOutput | null {
	const parseResult = parseAgentOutput(output, toolNames);
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

	return extractStructuredAuditMarkers(output);
}
