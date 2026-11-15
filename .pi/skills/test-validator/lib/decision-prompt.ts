// The judge prompt, and the reading of the answer envelope.
//
// Pure text shaping, so a prompt change is reviewable without touching the model
// call: the prompt carries exactly one test slice, its describe header, its
// file's imports, and the criteria — never another test's body, so a single
// verdict cannot lean on a neighbour.

import { fenceLanguage } from "./inventory-context.ts";
import type { DecisionRequest } from "./types.ts";

/**
 * The judge prompt: exactly one test slice, its describe header, its file's
 * imports, and the criteria.
 */
export function buildDecisionPrompt(
	request: DecisionRequest,
	criteriaText: string,
	criteriaIds: readonly string[],
): string {
	return [
		"You are auditing ONE automated test from a software repository.",
		"Decide whether this single test provides a meaningful project-specific",
		"regression or contract signal. Judge the test as written; you cannot run",
		"code and you cannot see other tests.",
		"",
		"# Criteria",
		"",
		criteriaText.trim(),
		"",
		`Criterion ids you may cite: ${criteriaIds.join(", ")}.`,
		"",
		"# Test under review",
		"",
		`File: ${request.file}`,
		`Lines: ${request.startLine}-${request.endLine}`,
		`Language: ${request.language}`,
		`Scope path: ${request.header === "" ? "(file level)" : request.header}`,
		`Test name: ${request.name}`,
		"",
		"## File imports and preamble",
		"",
		`\`\`\`${fenceLanguage(request.language)}`,
		request.imports === "" ? "(no imports)" : request.imports,
		"```",
		"",
		"## Test source",
		"",
		`\`\`\`${fenceLanguage(request.language)}`,
		request.slice,
		"```",
		"",
		"# Answer",
		"",
		"Reply with ONE JSON object and nothing else:",
		'{"decision":"GOOD|BAD|AMBIGUOUS","confidence":0.0,"criteria":["C1"],"reason":"one sentence","evidence":[{"line":0,"quote":"verbatim source line"}]}',
		"",
		"- GOOD when the test has project-specific regression or contract value.",
		"- BAD only when the evidence clearly shows it has none, with a",
		"  BAD-qualifying criterion and a quote copied verbatim from the slice.",
		"- AMBIGUOUS when you cannot tell from this slice alone.",
		"Style preferences, low coverage, overlap, broad scope, or external",
		"dependencies alone are never grounds for BAD.",
	].join("\n");
}

/** Concatenate the assistant's text blocks, ignoring non-text content. */
export function assistantText(message: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
	return message.content
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.filter((text) => text !== "")
		.join("\n");
}
