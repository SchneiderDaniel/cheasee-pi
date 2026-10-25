// ─── Agent Output Parser — Facade ────────────────────────────────
// Single deterministic parser for all agent outputs.
// Agents output structured JSON; this function parses and validates it.
// No regex fallback, no text marker scanning, no lastIndexOf lookups.
//
// Facade module: re-exports the parser core (parse-core.ts), the comment-body
// extractor (comment-extract.ts) and owns the parse-first
// extractStructuredAuditOutput. Parsing internals live in leaf modules
// (last-json-scanner.ts, validation.ts, structured-audit.ts) — imports flow
// one-way in here, never out. Callers keep importing from this path; the leaf
// exports are internal surface, not re-exported.

import type { AgentOutput } from "../config/types.ts";
import { isSuccess, parseAgentOutput } from "./parse-core.ts";
import { extractStructuredAuditMarkers } from "./structured-audit.ts";
import type { StructuredAuditOutput } from "./structured-audit.ts";

export type { StructuredAuditOutput } from "./structured-audit.ts";
export { stripTrailingMetadata } from "./structured-audit.ts";
export { getRefusalInfo, isRefused, isSuccess } from "./parse-core.ts";
export { normalizeEscapes, parseAgentOutput, stripAnsi } from "./parse-core.ts";
export { extractAgentCommentBody } from "./comment-extract.ts";

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
