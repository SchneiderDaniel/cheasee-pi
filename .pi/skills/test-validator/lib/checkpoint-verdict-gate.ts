// Adapter: re-apply the BAD gate to the verdicts a resume would otherwise trust.
//
// A checkpoint record is validated for *shape* when it is read, and shape is not
// policy: `{"decision":"BAD","criteria":["C4"]}` with a quote from another test is
// a well-formed record that must never be replayed as a decision. So every stored
// BAD verdict is re-checked against the current judged slice, the current criterion
// set, and the configured confidence threshold before a run counts it as done.
//
// A refused record stays in the file and its test is judged again by the model —
// nothing is deleted, and a resume can never report a BAD the gate would refuse.

import { badGateRefusal } from "./decision.ts";
import { verdictTargetFor } from "./decision-evidence.ts";
import { testKey } from "./types.ts";
import type { TestDefinition, Verdict } from "./types.ts";

/** A stored decision the gate refused, and why. */
interface RejectedVerdict {
	/** Identity of the test, as the checkpoint keys it. */
	readonly key: string;
	readonly reason: string;
}

export interface RevalidatedVerdicts {
	/** The stored decisions a run may treat as completed. */
	readonly verdicts: Map<string, Verdict>;
	/** The stored decisions it must judge again. */
	readonly rejected: readonly RejectedVerdict[];
}

export interface RevalidateInput {
	readonly verdicts: ReadonlyMap<string, Verdict>;
	/** The inventory this run is about to judge. */
	readonly definitions: readonly TestDefinition[];
	/** Source text by repository-relative path, for the judged slices. */
	readonly sources: ReadonlyMap<string, string>;
	readonly badConfidenceThreshold: number;
}

/** Split stored verdicts into "replayable" and "judge again", without mutation. */
export function revalidateStoredVerdicts(input: RevalidateInput): RevalidatedVerdicts {
	const byKey = new Map(input.definitions.map((def) => [testKey(def), def]));
	const verdicts = new Map<string, Verdict>();
	const rejected: RejectedVerdict[] = [];

	for (const [key, verdict] of input.verdicts) {
		if (verdict.decision === "GOOD") {
			verdicts.set(key, verdict);
			continue;
		}
		if (verdict.decision !== "BAD") {
			rejected.push({ key, reason: `decision: ${verdict.decision} is not a finished decision` });
			continue;
		}
		const def = byKey.get(key);
		if (def === undefined) {
			rejected.push({ key, reason: "inventory: the current inventory does not contain this test" });
			continue;
		}
		const source = input.sources.get(def.file);
		if (source === undefined) {
			rejected.push({
				key,
				reason: `source: no source text for ${def.file}, so the evidence cannot be checked`,
			});
			continue;
		}
		const refusal = badGateRefusal(
			verdict,
			verdictTargetFor(def, source),
			input.badConfidenceThreshold,
		);
		if (refusal !== null) {
			rejected.push({ key, reason: refusal });
			continue;
		}
		verdicts.set(key, verdict);
	}

	return { verdicts, rejected };
}
