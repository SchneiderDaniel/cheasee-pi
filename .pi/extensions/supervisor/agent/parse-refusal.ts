// ─── Refusal variant ────────────────────────────────────────────
// Refusal detection runs BEFORE schema validation: refusal prose is not
// schema-conforming by design, so a refusal short-circuits into a distinct
// RefusedOutput variant and never reaches validation. Detection keys on field
// PRESENCE, not non-empty reason text — empty-body refusals are legal
// (Anthropic stop_reason: "refusal" precedent).

import type { RefusedOutput } from "../config/types.ts";
import { normalizeEscapes } from "./parse-text.ts";

/** The refusal variant, or null when the payload is not a refusal. */
export function buildRefusalOutput(data: Record<string, unknown>): RefusedOutput | null {
	if (data.refusal === undefined || data.refusal === null) return null;

	const result: RefusedOutput = {
		refused: true,
		refusal: normalizeEscapes(String(data.refusal)),
	};
	if (data.agentName !== undefined && data.agentName !== null) {
		result.agentName = String(data.agentName);
	}
	if (data.summary !== undefined && data.summary !== null) {
		result.summary = String(data.summary);
	}
	if (data.commentBody !== undefined && data.commentBody !== null) {
		result.commentBody = normalizeEscapes(String(data.commentBody));
	}
	return result;
}
