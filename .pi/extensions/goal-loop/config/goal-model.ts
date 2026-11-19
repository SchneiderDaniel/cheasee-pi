// ─── goalLoop model resolution and capacity gate (R6) ────────────
// The configured model is authoritative: the resolver is called with the
// configured `provider/model-id` ONLY, never with the interactive session model
// (R6.AC2/R6.AC4). A silent fallback would make a run unreproducible.

import { failure, type Result } from "../../shared/result.ts";
import { parseModelRef, type ModelRef } from "../../shared/model/model-ref.ts";
import type { ModelResolver, ResolvedGoalModel } from "../application/ports.ts";

const SOURCE = "goalLoop";

/**
 * Parse the configured model reference and resolve it through the injected
 * resolver. A malformed ref, an unresolvable ref, or a resolver that returns
 * nothing each produce a failure naming the configured string.
 */
export function resolveGoalModel(
	configuredModel: string,
	resolve: ModelResolver,
): Result<ResolvedGoalModel> {
	let ref: ModelRef;
	try {
		ref = parseModelRef(configuredModel);
	} catch (err: unknown) {
		return failure(
			`goalLoop.model "${configuredModel}" is invalid: ${
				err instanceof Error ? err.message : String(err)
			}`,
			SOURCE,
		);
	}
	let resolved: ReturnType<ModelResolver>;
	try {
		resolved = resolve(ref.ref);
	} catch (err: unknown) {
		return failure(
			`goalLoop.model "${configuredModel}" could not be resolved: ${
				err instanceof Error ? err.message : String(err)
			}`,
			SOURCE,
		);
	}
	if (!resolved || !resolved.id) {
		return failure(`goalLoop.model "${configuredModel}" could not be resolved`, SOURCE);
	}
	return { ok: true, value: { ...resolved, ref: ref.ref } };
}

/**
 * Capacity gate (R5.AC1/R6.AC4): the configured rollover threshold plus Pi's
 * response reserve must fit the model's context window, otherwise the loop
 * would be forced to compact in place exactly where it must roll over.
 *
 * Boundary equality passes: `contextWindow === rolloverTokens + reserveTokens`
 * is accepted.
 */
export function checkModelCapacity(input: {
	modelRef: string;
	contextWindow: number;
	rolloverTokens: number;
	reserveTokens: number;
}): Result<void> {
	const required = input.rolloverTokens + input.reserveTokens;
	if (input.contextWindow >= required) return { ok: true, value: undefined };
	return failure(
		`goalLoop.contextRolloverTokens ${input.rolloverTokens} plus Pi's response reserve ` +
			`${input.reserveTokens} needs a context window of at least ${required} tokens, ` +
			`but model "${input.modelRef}" reports ${input.contextWindow}`,
		SOURCE,
	);
}
