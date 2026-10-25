// ─── Typed AgentOutput construction ─────────────────────────────
// Step 5 of the parse: turn the validated record into the typed AgentOutput,
// normalizing escapes on the multi-line text fields.

import type { AgentOutput } from "../config/types.ts";
import { normalizeEscapes } from "./parse-text.ts";

export function buildAgentOutput(data: Record<string, unknown>): AgentOutput {
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
