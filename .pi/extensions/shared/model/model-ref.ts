// ─── Model reference resolution (shared) ─────────────────────────
// Extracted from supervisor/agent/agent-session-runner.ts (issue #2138) so the
// goal-loop extension resolves `provider/model-id` strings through the exact
// same convention as Supervisor agents, with no fallback to the interactive
// session model.
//
// Two entry points:
// - `parseModelRef` splits the string only (no catalog lookup) — used by
//   settings validation, which must report a format error before touching the
//   model catalog.
// - `resolveModel` looks the ref up in the built-in catalog and throws on
//   failure, preserving the Supervisor's original error messages.

import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

/** A resolved model reference: the catalog entry plus provider/api identity. */
export interface ResolvedModelRef {
	id: string;
	provider: string;
	api: string;
}

/** A syntactically valid `provider/model-id` reference. */
export interface ModelRef {
	/** The original `provider/model-id` string. */
	ref: string;
	provider: string;
	modelId: string;
}

/**
 * Split `provider/model-id`. Model ids may contain slashes, so only the first
 * segment is the provider.
 *
 * @throws when `modelStr` is empty or has no provider segment.
 */
export function parseModelRef(modelStr: string | undefined): ModelRef {
	if (!modelStr || !modelStr.trim()) {
		throw new Error(`Agent has no model configured (config.model = "${modelStr ?? "undefined"}")`);
	}
	const parts = modelStr.split("/");
	if (parts.length < 2) {
		throw new Error(`Invalid model format "${modelStr}" — expected "provider/model-id"`);
	}
	const provider = parts[0]!;
	const modelId = parts.slice(1).join("/");
	if (!provider.trim() || !modelId.trim()) {
		throw new Error(`Invalid model format "${modelStr}" — expected "provider/model-id"`);
	}
	return { ref: modelStr, provider, modelId };
}

/**
 * Resolve a `provider/model-id` string to a catalog model.
 *
 * @throws with the original Supervisor message when the ref is malformed or
 * the catalog has no such model.
 */
export function resolveModel(modelStr: string | undefined): ResolvedModelRef {
	const { provider, modelId } = parseModelRef(modelStr);
	let resolved: ResolvedModelRef | undefined;
	try {
		resolved = getBuiltinModel(provider as any, modelId as any) as ResolvedModelRef | undefined;
	} catch (err: unknown) {
		throw new Error(
			`Model "${modelStr}" could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	// `getBuiltinModel` returns undefined for an unknown provider/model instead
	// of throwing, which used to fail later with a TypeError at the first
	// property access. Fail here with the same message prefix instead.
	if (!resolved) {
		throw new Error(
			`Model "${modelStr}" could not be resolved: no such model in the catalog (${provider}/${modelId})`,
		);
	}
	return resolved;
}
