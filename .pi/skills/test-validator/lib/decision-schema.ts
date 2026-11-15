// Domain: the schema a decision-model answer must satisfy.
//
// The model is untrusted input. Only strict JSON with a known decision, a
// non-empty reason, a confidence in [0, 1], known criterion ids, and a
// `{line, quote}` evidence array is accepted. Everything else is withheld as
// PENDING rather than interpreted.

import { isRecord, parseEvidence, type ParsedEvidence } from "./decision-evidence.ts";

/** Decisions the model is allowed to express. */
const ALLOWED_DECISIONS: ReadonlySet<string> = new Set(["GOOD", "BAD", "AMBIGUOUS"]);

/** A schema-valid answer. `AMBIGUOUS` never reaches this shape. */
export interface Envelope {
	readonly decision: "GOOD" | "BAD";
	readonly confidence: number;
	readonly criteria: readonly string[];
	readonly reason: string;
	readonly evidence: readonly ParsedEvidence[];
}

/** Either the validated answer or the reason it was withheld. */
type EnvelopeResult =
	| { readonly ok: true; readonly envelope: Envelope }
	| { readonly ok: false; readonly pendingReason: string };

function fail(pendingReason: string): EnvelopeResult {
	return { ok: false, pendingReason };
}

function reasonOf(parsed: Record<string, unknown>): string | null {
	const reason = parsed.reason;
	if (typeof reason !== "string" || reason.trim() === "") return null;
	return reason;
}

function confidenceOf(parsed: Record<string, unknown>): number | null {
	const confidence = parsed.confidence;
	const usable =
		typeof confidence === "number" &&
		Number.isFinite(confidence) &&
		confidence >= 0 &&
		confidence <= 1;
	return usable ? (confidence as number) : null;
}

/** Criterion ids, all of which the criteria file must define. */
function criteriaOf(
	parsed: Record<string, unknown>,
	criteriaIds: readonly string[],
): string[] | null {
	const criteria = parsed.criteria;
	if (!Array.isArray(criteria) || criteria.length === 0) return null;
	const known = new Set(criteriaIds);
	for (const id of criteria) {
		if (typeof id !== "string" || !known.has(id)) return null;
	}
	return [...(criteria as string[])];
}

/** Parse the model's raw text. No fence stripping: strict JSON only. */
export function readEnvelope(raw: string, criteriaIds: readonly string[]): EnvelopeResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return fail("payload: not valid JSON");
	}
	if (!isRecord(parsed)) return fail("payload: not a JSON object");

	const decision = parsed.decision;
	if (typeof decision !== "string" || !ALLOWED_DECISIONS.has(decision)) {
		return fail("schema: decision must be GOOD, BAD, or AMBIGUOUS");
	}
	if (decision === "AMBIGUOUS") return fail("ambiguous: model withheld a decision");

	const reason = reasonOf(parsed);
	if (reason === null) return fail("schema: reason is missing");

	const confidence = confidenceOf(parsed);
	if (confidence === null) return fail("schema: confidence is missing or not a number in [0, 1]");

	const criteria = criteriaOf(parsed, criteriaIds);
	if (criteria === null) return fail("schema: criteria must be known, non-empty ids");

	const evidence = parseEvidence(parsed.evidence);
	if (evidence === null) return fail("schema: evidence must be an array of {line, quote}");

	return {
		ok: true,
		envelope: { decision: decision as "GOOD" | "BAD", confidence, criteria, reason, evidence },
	};
}
