// ─── Agent Comment Body Extraction ────────────────────────────────
// Tries parseAgentOutput first for structured commentBody,
// falls back to COMMENT_BODY marker extraction.
// Split out of output.ts (issue #2033): imports the parser one way, never the
// facade, so there is no ESM cycle.

import type { AgentOutput } from "../config/types.ts";
import { isRefused, isSuccess, normalizeEscapes, parseAgentOutput } from "./parse-core.ts";
import { stripTrailingMetadata } from "./structured-audit.ts";
import { isContaminated, stripNoise } from "./comment-strip.ts";

export function extractAgentCommentBody(output: string, toolNames?: Set<string>): string | null {
	// Primary: parseAgentOutput for structured JSON
	const parseResult = parseAgentOutput(output, toolNames);
	if (isSuccess(parseResult)) {
		const agentOutput = parseResult as AgentOutput;
		if (agentOutput.commentBody) return agentOutput.commentBody;
	}

	// RefusedOutput: preserve the agent's own explanation when one was supplied.
	// Blank/whitespace-only commentBody is treated as absent so callers fall
	// through to marker extraction rather than posting an empty comment. Trim
	// is for blank detection only — non-blank bodies are returned verbatim,
	// never re-shaped (leading/trailing whitespace and markdown preserved).
	if (isRefused(parseResult)) {
		const body = parseResult.commentBody;
		if (body !== undefined && body.trim().length > 0) return body;
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

	if (lastBody) {
		lastBody = normalizeEscapes(lastBody);
		const stripped = stripNoise(lastBody, toolNames);
		if (stripped.length >= 50) {
			lastBody = stripped;
		}
		if (lastBody && isContaminated(lastBody)) {
			return null;
		}
	}

	return lastBody;
}
