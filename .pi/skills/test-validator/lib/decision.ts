// Domain: turn one raw decision-model answer into a verdict, and refuse to
// call a test BAD unless the evidence carries the whole gate.
//
// A verdict is GOOD or BAD only when it passes the schema in
// `decision-schema.ts` plus, for BAD, all three gate conditions: confidence at
// or above `badConfidenceThreshold`, at least one BAD-qualifying criterion, and
// at least one verbatim in-range quote. Anything else stays PENDING and is
// retried or reported as undecided. A pending verdict never claims to be BAD and
// never invents a reason or evidence.

import {
	isVerbatim,
	toVerdictEvidence,
	type ParsedEvidence,
	type VerdictTarget,
} from "./decision-evidence.ts";
import { readEnvelope, type Envelope } from "./decision-schema.ts";
import type { Verdict } from "./types.ts";

export { verdictTargetFor, type VerdictTarget } from "./decision-evidence.ts";

/**
 * The criteria ids the judge may cite. The definitions live in `criteria.md`;
 * this module only needs the ids to reject hallucinated ones.
 */
export const CRITERIA_IDS: readonly string[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"];

/**
 * Criteria that can justify a BAD verdict on their own: no project-owned
 * behaviour (C1), no meaningful observable assertion (C2), or no relevant
 * behaviour/contract coverage (C3). Style, clarity, reliability, duplication,
 * and observation-level criteria (C4–C7) never make a test bad by themselves.
 */
export const BAD_QUALIFYING_CRITERIA: ReadonlySet<string> = new Set(["C1", "C2", "C3"]);

/** A withheld decision. Carries a machine-readable why, never a verdict. */
function pending(reason: string): Verdict {
	return {
		decision: "PENDING",
		confidence: 0,
		criteria: [],
		reason: "",
		evidence: [],
		pendingReason: reason,
	};
}

function decided(
	decision: "GOOD" | "BAD",
	envelope: Envelope,
	evidence: readonly ParsedEvidence[],
): Verdict {
	return {
		decision,
		confidence: envelope.confidence,
		criteria: [...envelope.criteria],
		reason: envelope.reason,
		evidence: toVerdictEvidence(evidence),
		pendingReason: "",
	};
}

/**
 * The fields the BAD gate reads. A freshly parsed envelope and a verdict read
 * back from the checkpoint both satisfy it, so the same gate judges both.
 */
export interface GateInput {
	readonly confidence: number;
	readonly criteria: readonly string[];
	readonly evidence: readonly { readonly line: number; readonly quote: string }[];
}

/**
 * The BAD gate, in order: confidence, qualifying criterion, admissible quote.
 * Returns the reason a BAD claim is refused, or null when it holds.
 */
export function badGateRefusal(
	input: GateInput,
	target: VerdictTarget,
	threshold: number,
): string | null {
	if (input.confidence < threshold) {
		return `confidence: ${input.confidence} is below badConfidenceThreshold ${threshold}`;
	}
	const qualifying = input.criteria.some((id) => BAD_QUALIFYING_CRITERIA.has(id));
	if (!qualifying) {
		return `criteria: no BAD-qualifying criterion (${[...BAD_QUALIFYING_CRITERIA].join(", ")}) present`;
	}
	if (input.evidence.length === 0) return "evidence: no evidence provided";
	if (!input.evidence.some((entry) => isVerbatim(target, entry))) {
		return "evidence: no quote is a verbatim in-range substring of the judged lines";
	}
	return null;
}

/**
 * Parse a model answer into a verdict.
 *
 * @param raw the model's exact text (no fence stripping: strict JSON only)
 * @param target the judged slice, used for the evidence verbatim check
 * @param criteriaIds criterion ids the criteria file defines
 * @param cfg gate thresholds
 */
export function parseVerdict(
	raw: string,
	target: VerdictTarget,
	criteriaIds: readonly string[] = CRITERIA_IDS,
	cfg: { readonly badConfidenceThreshold: number } = { badConfidenceThreshold: 0.8 },
): Verdict {
	const parsed = readEnvelope(raw, criteriaIds);
	if (!parsed.ok) return pending(parsed.pendingReason);

	const envelope = parsed.envelope;
	if (envelope.decision === "GOOD") return decided("GOOD", envelope, envelope.evidence);

	const refusal = badGateRefusal(envelope, target, cfg.badConfidenceThreshold);
	if (refusal !== null) return pending(refusal);
	return decided("BAD", envelope, envelope.evidence);
}

/** True when a verdict is a final GOOD/BAD decision. */
export function isDecided(verdict: Verdict): boolean {
	return verdict.decision === "GOOD" || verdict.decision === "BAD";
}
